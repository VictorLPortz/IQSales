const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

function httpsPost(url, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(d) }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
 
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
 
// ═══════════════════════════════════════════════════════════════
// JSON SANITIZATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════
 
function sanitizeJSON(jsonStr) {
  return jsonStr
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/  +/g, ' ')
    .trim();
}
 
function aggressiveJSONClean(jsonStr) {
  let cleaned = jsonStr;
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
  cleaned = cleaned.replace(
    /"([^"]+)":\s*"([^"]*)"/g,
    function(match, key, value) {
      const escapedValue = value
        .replace(/\"/g, 'TEMP_ESCAPED_QUOTE')
        .replace(/"/g, '\"')
        .replace(/TEMP_ESCAPED_QUOTE/g, '\"');
      return `"${key}": "${escapedValue}"`;
    }
  );
  cleaned = cleaned.replace(/[-]/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}
 
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
 
  try {
    // ── DALL-E billedgenerering ──────────────────────────────────
    if (req.body.action === 'dalle') {
      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: 'Mangler prompt' });

      const result = await httpsPost(
        'https://api.openai.com/v1/images/generations',
        {
          model: 'dall-e-3',
          prompt: prompt + '. Photorealistic, professional insurance damage photo. No people.',
          n: 1,
          size: '1024x1024',
          quality: 'standard'
        },
        { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
      );

      if (result.status !== 200) return res.status(500).json({ error: result.data.error?.message || 'OpenAI fejl' });
      return res.status(200).json({ url: result.data.data[0].url });
    }
    // ── Ende DALL-E ──────────────────────────────────────────────

    // ── Scenariegenerering ───────────────────────────────────────
    if (req.body.action === 'scenario') {
      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: 'Mangler prompt' });

      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      });

      return res.status(200).json({ text: msg.content[0].text });
    }
    // ── Ende scenarie ────────────────────────────────────────────

    const { companyA, companyB, type } = req.body;
    
    if (!companyA || !companyB || !type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
 
    const startTime = Date.now();
    let userId = null;
    
    // Get user ID from auth header — REQUIRED
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Ikke autoriseret. Log ind for at bruge IQSales.' });
    }

    const token = authHeader.replace('Bearer ', '');
    try {
      const verifyResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${token}`
        }
      });
      if (!verifyResponse.ok) {
        return res.status(401).json({ error: 'Ugyldig session. Log ind igen.' });
      }
      const userData = await verifyResponse.json();
      if (!userData.id) {
        return res.status(401).json({ error: 'Ugyldig session. Log ind igen.' });
      }
      userId = userData.id;
    } catch (error) {
      console.error('Auth verification failed:', error);
      return res.status(401).json({ error: 'Kunne ikke verificere login. Prøv igen.' });
    }
 
    // Rate limit: maks 50 analyser pr. bruger pr. dag (150 for admins)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [rateLimitResponse, profileResponse] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/analytics?user_id=eq.${userId}&event_type=eq.analysis_completed&timestamp=gte.${todayStart.toISOString()}&select=id`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=role`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      )
    ]);

    if (rateLimitResponse.ok && profileResponse.ok) {
      const todayAnalyses = await rateLimitResponse.json();
      const profileData = await profileResponse.json();
      const isAdmin = profileData?.[0]?.role === 'admin';
      const dailyLimit = isAdmin ? 150 : 50;
      if (todayAnalyses.length >= dailyLimit) {
        return res.status(429).json({ error: `Daglig grænse på ${dailyLimit} analyser nået. Prøv igen i morgen.` });
      }
    }

    // Check cache first
    const CACHE_VERSION = 'v2'; // bump this to invalidate cache (e.g. when prompt changes)
    const cacheKey = `${CACHE_VERSION}-${type}-${companyA}-${companyB}`;
    const cacheResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/analysis_cache?insurance_type=eq.${encodeURIComponent(type)}&company_a=eq.${encodeURIComponent(companyA)}&company_b=eq.${encodeURIComponent(companyB)}&select=*`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );
 
    if (cacheResponse.ok) {
      const cacheData = await cacheResponse.json();
      if (cacheData && cacheData.length > 0) {
        const cached = cacheData[0];

        // Invalidate cache if result lacks source references (old format without page_a/section_a)
        const firstItem = cached.result?.coverage?.[0];
        const hasSourceRefs = firstItem && ('page_a' in firstItem);
        if (!hasSourceRefs) {
          console.log('🔄 Cache stale: missing source refs, re-analyzing...');
          // Fall through to fresh analysis below
        } else {

        // Log cache hit
        if (userId) {
          await fetch(`${SUPABASE_URL}/rest/v1/analytics`, {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
              user_id: userId,
              event_type: 'analysis_completed',
              insurance_type: type,
              company_a: companyA,
              company_b: companyB,
              cache_used: true,
              response_time_ms: Date.now() - startTime,
              tokens_used: 0,
              cost_estimate: 0
            })
          });
        }
 
        return res.status(200).json(cached.result);
        }
      }
    }
 
    // Fetch PDFs from insurance_terms
    const pdfAResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/insurance_terms?selskab=eq.${encodeURIComponent(companyA)}&produkt_type=eq.${encodeURIComponent(type)}&select=full_text,pdf_hash`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );
 
    const pdfBResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/insurance_terms?selskab=eq.${encodeURIComponent(companyB)}&produkt_type=eq.${encodeURIComponent(type)}&select=full_text,pdf_hash`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );
 
    if (!pdfAResponse.ok || !pdfBResponse.ok) {
      throw new Error('PDFs not found in database');
    }
 
    const [pdfA] = await pdfAResponse.json();
    const [pdfB] = await pdfBResponse.json();
 
    if (!pdfA || !pdfB) {
      throw new Error('PDFs not found in database');
    }
 
    // Fetch approved feedback + vigtig/ligegyldig ratings for this insurance type
    const [feedbackResponse, importantResponse, irrelevantResponse] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/feedback?insurance_type=eq.${encodeURIComponent(type)}&status=eq.approved&select=*`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/feedback?insurance_type=eq.${encodeURIComponent(type)}&issue_type=eq.priority_high&select=category`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/feedback?insurance_type=eq.${encodeURIComponent(type)}&issue_type=eq.priority_low&select=category`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      )
    ]);

    const allFeedbacks = feedbackResponse.ok ? await feedbackResponse.json() : [];
    const importantRaw = importantResponse.ok ? await importantResponse.json() : [];
    const irrelevantRaw = irrelevantResponse.ok ? await irrelevantResponse.json() : [];

    // Filtrer feedback på selskab — inkluder feedback der er generel (company=null) eller matcher et af de to selskaber
    const feedbacks = allFeedbacks.filter(f => !f.company || f.company === companyA || f.company === companyB);

    // Sorter: prioriterede feedback øverst
    feedbacks.sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0));

    // Kategorier fra prioriteret feedback skal altid med i coverage items
    const mandatoryCategories = feedbacks.filter(f => f.priority).map(f => f.category);
    // Count votes per category
    const importantCounts = {};
    importantRaw.forEach(f => { if(f.category) importantCounts[f.category] = (importantCounts[f.category]||0)+1; });
    const irrelevantCounts = {};
    irrelevantRaw.forEach(f => { if(f.category) irrelevantCounts[f.category] = (irrelevantCounts[f.category]||0)+1; });

    // Top 5 vigtigste og top 5 mest ligegyldige
    const topImportant = Object.entries(importantCounts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([cat])=>cat);
    const topIrrelevant = Object.entries(irrelevantCounts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([cat])=>cat);

    console.log(`📊 Vigtige dækninger: ${topImportant.join(', ')}`);
    console.log(`📊 Ligegyldige dækninger: ${topIrrelevant.join(', ')}`);
 
    // Build prompt with type-specific instructions
    let prompt = buildPrompt(companyA, companyB, type, pdfA.full_text, pdfB.full_text, feedbacks, topImportant, topIrrelevant, mandatoryCategories);
 
    console.log(`🔄 Starting analysis: ${companyA} vs ${companyB} for ${type}`);
 
    // Call Claude API with retry logic
    let message;
    let attempt = 0;
    const maxAttempts = 2;
 
    while (attempt < maxAttempts) {
      attempt++;
      try {
        console.log(`🔄 API attempt ${attempt}/${maxAttempts}`);
        message = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 30000,
          system: getSystemPrompt(type),
          messages: [{
            role: 'user',
            content: prompt
          }]
        });
        break; // Success
      } catch (apiError) {
        console.error(`❌ API attempt ${attempt} failed:`, apiError.message);
        if (attempt >= maxAttempts) {
          throw new Error(`Claude API fejlede efter ${maxAttempts} forsøg: ${apiError.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
 
    // Parse response - robust extraction
    const txt = message.content.map(function(i) { return i.type === 'text' ? i.text : ''; }).join('\n');
    let cleanedText = txt.replace(/```json|```/g, '').trim();
 
    // Extract first complete JSON object using bracket matching
    let jsonStr = null;
    let depth = 0;
    let startIndex = -1;
    for (let i = 0; i < cleanedText.length; i++) {
      const char = cleanedText[i];
      if (char === '{') {
        if (depth === 0) startIndex = i;
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && startIndex !== -1) {
          jsonStr = cleanedText.substring(startIndex, i + 1);
          break;
        }
      }
    }
 
    if (!jsonStr) {
      console.error('❌ No complete JSON object found in response');
      throw new Error('Claude returnerede ikke valid JSON format');
    }
 
    // Sanitize and parse JSON
    jsonStr = sanitizeJSON(jsonStr);
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error('❌ JSON Parse Error:', parseError.message);
      console.log('🔄 Attempting aggressive JSON cleaning...');
      try {
        jsonStr = aggressiveJSONClean(jsonStr);
        parsed = JSON.parse(jsonStr);
        console.log('✅ Aggressive cleaning succeeded!');
      } catch (secondError) {
        console.error('❌ Aggressive cleaning also failed:', secondError.message);
        throw new Error('Claude returnerede ugyldig JSON. Prøv igen eller kontakt support.');
      }
    }
 
    // ✨ POST-PROCESSING: Fix critical bugs
    if (parsed.coverage && Array.isArray(parsed.coverage)) {
      const beforeCount = parsed.coverage.length;
 
      parsed.coverage = parsed.coverage
        .map(item => {
          let status_a = item.status_a;
          let status_b = item.status_b;
          let winner = item.winner;
 
          // FIX 1: Fix status when amount text contradicts it
          if (item.amount_a && typeof item.amount_a === 'string') {
            const lower = item.amount_a.toLowerCase();
            if (lower.includes('ikke dækket') || lower.includes('dækkes ikke') || lower.includes('ingen dækning') || lower.includes('undtaget')) {
              status_a = 'no';
            }
          }
          if (item.amount_b && typeof item.amount_b === 'string') {
            const lower = item.amount_b.toLowerCase();
            if (lower.includes('ikke dækket') || lower.includes('dækkes ikke') || lower.includes('ingen dækning') || lower.includes('undtaget')) {
              status_b = 'no';
            }
          }
 
          // FIX 2: Fix winner when A covers and B explicitly excludes (or vice versa)
          if (status_a === 'yes' && status_b === 'no') winner = 'a';
          if (status_a === 'no' && status_b === 'yes') winner = 'b';
 
          // Resolve status safely - only fix truly missing/invalid statuses
          // IMPORTANT: Run AFTER FIX 1 text-based corrections so we don't override them
          const validStatuses = ['yes', 'no', 'inib', 'excluded'];
          const resolveStatus = (st, amount) => {
            // If already a valid status, keep it (respects FIX 1 corrections above)
            if (st && validStatuses.includes(st.toLowerCase())) return st.toLowerCase();
            // Status is missing or invalid - infer from amount text
            if (amount && typeof amount === 'string') {
              const lower = amount.toLowerCase().trim();
              if (lower.length < 2) return 'inib';
              // Text indicates not covered
              if (lower.includes('ikke dækket') || lower.includes('dækkes ikke') || 
                  lower.includes('ingen dækning') || lower.includes('undtaget') ||
                  lower === 'ikke dækket') return 'no';
              // Has real content - assume covered
              return 'yes';
            }
            if (amount && typeof amount === 'object') return 'yes';
            return 'inib';
          };
          status_a = resolveStatus(status_a, item.amount_a);
          status_b = resolveStatus(status_b, item.amount_b);
 
          return {
            ...item,
            status_a,
            status_b,
            winner,
            sales_tip: item.sales_tip || '',
            objection_tip: item.objection_tip || '',
            customer_explanation: item.customer_explanation || ''
          };
        })
        // FIX 3: Remove items where both explicitly exclude (no vs no) - no difference to show
        .filter(item => {
          if (item.status_a === 'no' && item.status_b === 'no') {
            console.log(`❌ Filtered: Both exclude "${item.category}"`);
            return false;
          }
          if (item.status_a === 'inib' && item.status_b === 'inib') {
            console.log(`❌ Filtered: Both INIB "${item.category}"`);
            return false;
          }
          return true;
        });
 
      console.log(`✅ Processed: ${beforeCount} → ${parsed.coverage.length} items (removed ${beforeCount - parsed.coverage.length})`);
    }
 
    // Cache the result
    await fetch(`${SUPABASE_URL}/rest/v1/analysis_cache`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        insurance_type: type,
        company_a: companyA,
        company_b: companyB,
        result: parsed
      })
    });
 
    // Log analytics
    if (userId) {
      const responseTime = Date.now() - startTime;
      const tokensUsed = message.usage.input_tokens + message.usage.output_tokens;
      const costEstimate = (message.usage.input_tokens * 0.003 / 1000) + (message.usage.output_tokens * 0.015 / 1000);
 
      await fetch(`${SUPABASE_URL}/rest/v1/analytics`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          user_id: userId,
          event_type: 'analysis_completed',
          insurance_type: type,
          company_a: companyA,
          company_b: companyB,
          cache_used: false,
          response_time_ms: responseTime,
          tokens_used: tokensUsed,
          cost_estimate: costEstimate
        })
      });
    }
 
    return res.status(200).json(parsed);
 
  } catch (error) {
    console.error('Analysis failed:', error);
    
    // Log failure
    if (req.body.userId) {
      await fetch(`${SUPABASE_URL}/rest/v1/analytics`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          user_id: req.body.userId,
          event_type: 'analysis_failed',
          insurance_type: req.body.type,
          company_a: req.body.companyA,
          company_b: req.body.companyB
        })
      });
    }
 
    return res.status(500).json({ 
      error: error.message || 'Analysis failed'
    });
  }
}
 
// ═══════════════════════════════════════════════════════════════
// PROMPT BUILDER WITH TYPE-SPECIFIC INSTRUCTIONS
// ═══════════════════════════════════════════════════════════════
 
function buildPrompt(companyA, companyB, type, textA, textB, feedbacks, topImportant, topIrrelevant, mandatoryCategories = []) {
  let prompt = `Sammenlign ${companyA} og ${companyB} for ${type}.
 
SELSKAB A (${companyA}) BETINGELSER:
${textA.substring(0, 100000)}
 
SELSKAB B (${companyB}) BETINGELSER:
${textB.substring(0, 100000)}
`;
 
  if (feedbacks.length > 0) {
    prompt += `\n\nGODKENDT FEEDBACK (VIGTIGT - tag højde for dette):\n`;
    prompt += `REGEL 1: Dækninger markeret som prioriterede (⭐) SKAL altid inkluderes i dine 20 coverage items.\n`;
    prompt += `REGEL 2: Feedback der er knyttet til et specifikt selskab gælder kun for det selskab — brug det til at beskrive det selskabs dækning præcist.\n`;
    prompt += `REGEL 3: Inkluder specifikke detaljer (beløb, procenter, tidsrum, undtagelser) direkte i "reason"-feltet. Forkort ikke.\n`;
    if (mandatoryCategories.length > 0) {
      prompt += `\n⭐ OBLIGATORISKE DÆKNINGER (skal altid med):\n`;
      mandatoryCategories.forEach((cat, i) => { prompt += `${i + 1}. ${cat}\n`; });
    }
    prompt += `\nFEEDBACK:\n`;
    feedbacks.forEach(function(f, i) {
      const companyTag = f.company ? ` [${f.company}]` : '';
      const priorityTag = f.priority ? ' ⭐' : '';
      prompt += `${i + 1}.${priorityTag}${companyTag} ${f.category}: ${f.comment}\n`;
    });
  }
 
  // Add vigtig/ligegyldig ratings
  if (topImportant && topImportant.length > 0) {
    prompt += `\n\nSÆLGERNES PRIORITETER (baseret på afstemninger):\n`;
    prompt += `FREMHÆV SÆRLIGT disse dækninger - sælgerne finder dem vigtige for kunderne:\n`;
    topImportant.forEach(function(cat, i) {
      prompt += `${i+1}. ${cat}\n`;
    });
  }

  if (topIrrelevant && topIrrelevant.length > 0) {
    prompt += `\n\nNEDPRIORITÉR disse dækninger - sælgerne finder dem ligegyldige:\n`;
    topIrrelevant.forEach(function(cat, i) {
      prompt += `${i+1}. ${cat}\n`;
    });
    prompt += `(Medtag kun hvis der er en markant forskel)\n`;
  }

  // Add type-specific instructions
  const typeGuide = getTypeSpecificGuide(type);
  if (typeGuide) {
    prompt += `\n\n${typeGuide}`;
  }
 
  prompt += `\n\n⚠️ VIGTIGT: Returner MAX 20 coverage items.
 
PRIORITÉR I DENNE RÆKKEFØLGE:
1. Store beløbsforskelle (f.eks. 50.000 kr vs 100.000 kr)
2. Dækninger hvor kun ÉT selskab dækker (status: yes vs no/inib)
3. Markant bedre vilkår (f.eks. selvrisiko 2.500 kr vs 5.000 kr)
4. Kritiske dækninger som kunden ofte spørger om
 
SPRING OVER:
- Dækninger hvor begge er "inib" (ikke nævnt af nogen)
- Meget små forskelle under 5.000 kr
- Ansvarsforsikring (medmindre markant forskel)
 
Returner JSON med: type, companyA, companyB, coverage (array), pitch, top3_a, top3_b.`;
 
  return prompt;
}
 
function getTypeSpecificGuide(type) {
  const guides = {
    'Sundhedsforsikring': `
🔍 SPECIFIKT FOR SUNDHEDSFORSIKRING:
Find konkrete dækninger: Behandlingsgaranti (ventetid), Speciallæge, Fysioterapi, Psykolog, Kiropraktor, Scanning/MR, Kræftbehandling, Operationer, Tandbehandling, Medicin.
Vær specifik om ventetider og maksimumsbeløb!`,
 
    'Lystfartøj': `
🔍 SPECIFIKT FOR LYSTFARTØJ:
Find konkrete dækninger som: Kaskoforsikring, Maskinskade, Trailer, Bjærgning, Sejlområde, Udstyr om bord.
ALDRIG bare "Ukendt dækning" - find det specifikke navn!`,
 
    'Fritidshus': `
🔍 SPECIFIKT FOR FRITIDSHUS:
DIFFERENTIER bygningsskader: "Bygning - Stormskade", "Bygning - Vandskade", "Bygning - Solceller"
ALDRIG bare "Bygning" uden specifikation!`,
 
    'Hund': `
🔍 SPECIFIKT FOR HUND:
Find konkrete dækninger: Veterinærbehandling, Hundesygdom, Tandbehandling, Ansvar.
ALDRIG "Ukendt dækning"!`,
 
    'Motorcykel': `
🔍 SPECIFIKT FOR MOTORCYKEL:
Vær specifik om: Nyværdierstatning (hvor længe?), Kaskodækning, Glasskader, Tilbehør.`,
 
    'Campingvogn': `
🔍 SPECIFIKT FOR CAMPINGVOGN:
Differentier: Vognen selv vs Fortelt vs Indbo vs Udstyr.`
  };
 
  return guides[type] || null;
}
 
// ═══════════════════════════════════════════════════════════════
// SYSTEM PROMPT - ENHANCED WITH EXPLICIT RULES
// ═══════════════════════════════════════════════════════════════
 
function getSystemPrompt(type) {
  return `Du er Danmarks mest erfarne forsikringsekspert med 20+ års erfaring i at sammenligne forsikringsbetingelser.
 
# DIN OPGAVE
Analyser de to sæt forsikringsbetingelser MEGET nøje og identificer præcist hvad hvert selskab dækker og IKKE dækker.
 
# KRITISKE REGLER FOR SAMMENLIGNING
 
## ✅ REGEL 1: Højere beløb = Fordel
Hvis Selskab A dækker 50.000 kr og Selskab B dækker 100.000 kr → winner=b
 
## ✅ REGEL 2: Kun én nævner dækningen = Fordel
Hvis Selskab A nævner "blæsevejr" og Selskab B ikke gør → winner=a
VIGTIGT: Dette gælder MEDMINDRE Selskab B eksplicit undtager det.
 
## ✅ REGEL 3: Bedre vilkår = Fordel
Lavere selvrisiko, længere periode, bredere geografi = Fordel
 
## ⚖️ REGEL 4: Vage beløb = Equal
"50.000 kr" vs "fremgår af police" → winner=equal
 
## 🚫 REGEL 5: Spring over når begge er ens negative
Hvis BEGGE ikke nævner det (inib+inib) → SKIP!
Hvis BEGGE eksplicit undtager (no+no) → SKIP!
Vi vil KUN se dækninger hvor der er en REEL FORSKEL!
 
## ✅ REGEL 6: Dækket med begrænsninger > Undtaget
Hvis A dækker (selv med begrænsninger) OG B eksplicit undtager → winner=a
Eksempel:
- A: "Dækket op til 10% - dog ikke fra ubeboet bolig" → status_a=yes
- B: "Ikke dækket - huset anses ubeboet ved weekendophold" → status_b=no
→ winner=a (A dækker, B undtager!)
 
## 📊 Status-definitioner (brug KUN disse 4):
- **yes**: Dækkes eksplicit med konkrete vilkår
- **no**: Forsikringen nævner det men dækker det IKKE (f.eks. "vi dækker ikke skader på løsøre")
- **excluded**: Eksplicit UNDTAGET — forsikringen dækker normalt denne type men undtager specifikt dette scenarie (f.eks. "storm dækkes, men ikke hvis bygningen er ubeboet")
- **inib**: Ikke Nævnt I Betingelserne — dækningen omtales slet ikke
 
## 🔥 KRITISK: FORSKEL PÅ "no" OG "excluded"
- **no** = Forsikringen siger direkte at denne ting ikke dækkes: "Skader på løsøre er ikke dækket"
- **excluded** = Forsikringen dækker normalt, men undtager SPECIFIKT dette scenarie: "Stormskade dækkes — dog ikke hvis ejendommen er ubeboet mere end 60 dage"
 
## 🔥 KRITISK: STATUS OG AMOUNT KONSISTENS
Når du skriver status og amount, skal de MATCHE:
- Hvis status="yes" → amount skal beskrive hvad der dækkes (f.eks. "Op til 50.000 kr")
- Hvis status="no" → amount skal sige "Ikke dækket" eller forklare undtagelsen
- Hvis status="inib" → amount skal være null
 
⚠️ FORKERT eksempel:
{
  "status_b": "yes",  ← FORKERT!
  "amount_b": "Dækkes ikke - kun storm..."  ← Dette er en no-status!
}
 
✅ KORREKT eksempel:
{
  "status_b": "no",  ← Korrekt!
  "amount_b": "Dækkes ikke - kun storm over 17,2 m/s dækkes"
}
 
## 🔥 KRITISK: KONKRETE CATEGORIES
- HVER coverage item SKAL have et KONKRET category navn
- ✅ GODT: "Stormskade", "Nyværdierstatning første år", "Veterinærbehandling"
- ❌ DÅRLIGT: "Ukendt dækning", "Ekstra dækning", "Bygning" (uden specifikation)
- Hvis du finder flere ting i samme kategori → differentier: "Bygning - Stormskade", "Bygning - Solceller"

## 🔥 KRITISK: AMOUNT FELTER SKAL ALTID VÆRE STRINGS
- amount_a og amount_b SKAL ALTID være TEXT STRINGS — ALDRIG objekter!
- ✅ KORREKT: "amount_a": "Dækker op til 50.000 kr med selvrisiko 2.500 kr"
- ✅ KORREKT: "amount_a": "Ikke dækket — kun storm over 17,2 m/s dækkes"
- ❌ FORKERT: "amount_a": {"covered": false, "details": "..."}
- ❌ FORKERT: "amount_a": null (når status er "yes"!)
- Hvis status er "yes" → SKRIV hvad der dækkes som en TEXT STRING
- Hvis status er "no" → SKRIV hvad der IKKE dækkes som en TEXT STRING
- Hvis status er "inib" → sæt amount til null
 
 
# EKSEMPEL 0a: SKIP - Begge undtager (no+no)
❌ MEDTAG IKKE:
{
  "category": "Oversvømmelse fra hav",
  "status_a": "no",
  "status_b": "no"
  → SKIP! Ingen forskel - begge undtager det
}
 
# EKSEMPEL 0b: REGEL 6 - Dækket > Undtaget
✅ MEDTAG:
{
  "category": "Simpelt tyveri - ubeboet",
  "status_a": "yes",
  "status_b": "no",
  "amount_a": "Dækket op til 10% af forsikringssummen",
  "amount_b": "Ikke dækket - huset anses ubeboet ved weekendophold",
  "winner": "a"
}
 
# EKSEMPEL 1: Højere beløb
{
  "category": "Personskade",
  "status_a": "yes",
  "status_b": "yes", 
  "amount_a": "50.000 kr",
  "amount_b": "100.000 kr",
  "winner": "b",
  "reason": "Selskab B dækker dobbelt så meget"
}
 
# EKSEMPEL 2: Kun én nævner
{
  "category": "Blæsevejr under stormstyrke",
  "status_a": "yes",
  "status_b": "inib",
  "amount_a": "Dækkes ved vindstyrke under 17,2 m/s",
  "amount_b": null,
  "winner": "a",
  "reason": "Kun Selskab A dækker blæsevejr - ikke nævnt hos B"
}
 
# EKSEMPEL 3: Eksplicit ikke dækket
{
  "category": "Stormskade under vindstyrke 8",
  "status_a": "yes",
  "status_b": "no",
  "amount_a": "Dækkes fra vindstyrke 5",
  "amount_b": "Ikke dækket - kun storm over 17,2 m/s dækkes",
  "winner": "a",
  "reason": "Selskab A dækker blæsevejr, Selskab B undtager det eksplicit"
}
 
## 📍 KILDEREFERENCER (page_a, section_a, page_b, section_b)
For HVER coverage item skal du angive præcis hvor i betingelserne du fandt informationen:
- **page_a / page_b**: Sidenummer som heltal (f.eks. 12). Sæt null hvis ikke angivet i dokumentet.
- **section_a / section_b**: Det præcise afsnits- eller paragrafnavn (f.eks. "Afsnit 4.2 - Stormskade" eller "Afsnit 3 - Branddækning"). Sæt null hvis ikke tydeligt angivet.

✅ KORREKT eksempel:
{
  "category": "Stormskade",
  "page_a": 8,
  "section_a": "Afsnit 4 - Naturfaenomener",
  "page_b": 12,
  "section_b": "Afsnit 6.1 Storm og orkan"
}

❌ FORKERT: Lad være med at opfinde sidenumre — skriv null hvis du er i tvivl.

# OUTPUT FORMAT
Returner KUN valid JSON uden markdown backticks:
{
  "type": "${type}",
  "companyA": "Selskab A navn",
  "companyB": "Selskab B navn",
  "coverage": [
    {
      "category": "Konkret dækningsnavn",
      "status_a": "yes/no/inib",
      "status_b": "yes/no/inib",
      "amount_a": "Beløb eller beskrivelse (eller null hvis inib)",
      "amount_b": "Beløb eller beskrivelse (eller null hvis inib)",
      "winner": "a/b/equal",
      "reason": "Forklaring",
      "sales_tip": "Kort salgstip hvis winner=a",
      "objection_tip": "Håndtering hvis winner=b",
      "customer_explanation": "Simpel forklaring",
      "page_a": 8,
      "section_a": "Afsnit 4 - Stormskade",
      "page_b": 12,
      "section_b": "Afsnit 6.1 Storm og orkan"
    }
  ],
  "pitch": {
    "why_switch": "Hvorfor skifte?",
    "money_saved": "Besparelse"
  },
  "top3_a": ["Fordel 1", "Fordel 2", "Fordel 3"],
  "top3_b": ["Fordel 1", "Fordel 2", "Fordel 3"]
}`;
}
