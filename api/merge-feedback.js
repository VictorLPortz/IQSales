import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth check — kræv gyldigt login + admin
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Ikke autoriseret. Log ind for at bruge IQSales.' });
  }
  const token = authHeader.replace('Bearer ', '');
  let userId = null;
  try {
    const verifyResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` }
    });
    if (!verifyResponse.ok) return res.status(401).json({ error: 'Ugyldig session. Log ind igen.' });
    const userData = await verifyResponse.json();
    if (!userData.id) return res.status(401).json({ error: 'Ugyldig session. Log ind igen.' });
    userId = userData.id;
  } catch (e) {
    return res.status(401).json({ error: 'Kunne ikke verificere login.' });
  }

  try {
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=role`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const profiles = await profileRes.json();
    if (!profiles?.[0] || profiles[0].role !== 'admin') {
      return res.status(403).json({ error: 'Kun admins kan samle feedback' });
    }
  } catch (e) {
    return res.status(401).json({ error: 'Auth fejl' });
  }

  const { types } = req.body;
  if (!types || !Array.isArray(types) || types.length === 0) {
    return res.status(400).json({ error: 'types (array) påkrævet' });
  }

  try {
    // Hent godkendt feedback for de valgte typer
    const typeFilter = types.map(t => encodeURIComponent(t)).join(',');
    const feedbackRes = await fetch(
      `${SUPABASE_URL}/rest/v1/feedback?status=eq.approved&insurance_type=in.(${typeFilter})&select=id,insurance_type,category,comment,created_at`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const feedback = await feedbackRes.json();

    if (!feedback || feedback.length === 0) {
      return res.status(200).json({ results: [] });
    }

    // Gruppér per type + kategori
    const groups = {};
    feedback.forEach(f => {
      const type = f.insurance_type || 'Generel';
      const cat = f.category || 'Generel feedback';
      const key = type + '|||' + cat;
      groups[key] = groups[key] || { type, category: cat, items: [] };
      groups[key].items.push(f);
    });

    const groupList = Object.values(groups);

    // Kategorier med kun 1 entry skal ikke merges
    const singleGroups = groupList.filter(g => g.items.length === 1);
    const multiGroups = groupList.filter(g => g.items.length > 1);

    let mergedResults = [];

    if (multiGroups.length > 0) {
      // Byg prompt til Claude — én samlet anmodning for alle kategorier med duplikater
      const promptSections = multiGroups.map((g, idx) =>
        `### Gruppe ${idx + 1}\nForsikringstype: ${g.type}\nKategori: ${g.category}\nKommentarer fra sælgere:\n${g.items.map((it, i) => `${i + 1}. "${it.comment || ''}"`).join('\n')}`
      ).join('\n\n');

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: `Du hjælper med at samle dubleret sælger-feedback om forsikringsdækninger til IQSales.

For hver gruppe får du flere kommentarer fra forskellige sælgere om samme dækningskategori. Din opgave:
1. Sammenskriv kommentarerne til ÉN kort, klar kommentar der bevarer de vigtigste faktuelle pointer fra alle kommentarer.
2. Generiske kommentarer som "Vigtig dækning - skal med" eller "Ligegyldig dækning - kan udelades" skal bevares som signal hvis de er de eneste, men hvis der ER en substantiel/faktuel kommentar i gruppen, prioriter den og inkluder evt. det generiske signal kort.
3. Hvis kommentarerne i en gruppe MODSIGER hinanden (f.eks. én siger "dækket" og en anden siger "ikke dækket" om samme ting), sæt "conflict": true og forklar uenigheden kort i "note" — lad "merged" være dit bedste forslag til formulering, så admin kan redigere.
4. Hold merged-kommentaren under 200 tegn hvor muligt.

Returner KUN valid JSON, ingen markdown:
{
  "results": [
    { "group": 1, "merged": "...", "conflict": false, "note": "" }
  ]
}`,
        messages: [{ role: 'user', content: promptSections }]
      });

      const txt = message.content.map(c => c.type === 'text' ? c.text : '').join('');
      const cleaned = txt.replace(/```json|```/g, '').trim();

      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (e) {
        // Fallback: behold længste kommentar per gruppe hvis parsing fejler
        parsed = { results: multiGroups.map((g, idx) => ({
          group: idx + 1,
          merged: g.items.reduce((longest, it) => (it.comment || '').length > (longest || '').length ? it.comment : longest, ''),
          conflict: false,
          note: ''
        })) };
      }

      mergedResults = multiGroups.map((g, idx) => {
        const r = (parsed.results || []).find(x => x.group === idx + 1) || {};
        return {
          type: g.type,
          category: g.category,
          ids: g.items.map(it => it.id),
          original_count: g.items.length,
          original_comments: g.items.map(it => it.comment),
          merged: r.merged || g.items[0].comment,
          conflict: !!r.conflict,
          note: r.note || ''
        };
      });
    }

    // Single-entry grupper sendes med uden ændring
    const singleResults = singleGroups.map(g => ({
      type: g.type,
      category: g.category,
      ids: g.items.map(it => it.id),
      original_count: 1,
      original_comments: g.items.map(it => it.comment),
      merged: g.items[0].comment,
      conflict: false,
      note: ''
    }));

    return res.status(200).json({ results: [...mergedResults, ...singleResults] });

  } catch (error) {
    console.error('Merge feedback failed:', error);
    return res.status(500).json({ error: error.message || 'Merge fejlede' });
  }
}
