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

  try {
    const { companyA, companyB, type } = req.body;
    
    if (!companyA || !companyB || !type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const startTime = Date.now();
    let userId = null;
    
    // Get user ID from auth header
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const token = authHeader.replace('Bearer ', '');
      try {
        const verifyResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${token}`
          }
        });
        if (verifyResponse.ok) {
          const userData = await verifyResponse.json();
          userId = userData.id;
        }
      } catch (error) {
        console.error('Auth verification failed:', error);
      }
    }

    // Check cache first
    const cacheKey = `${type}-${companyA}-${companyB}`;
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

    // Fetch approved feedback for this insurance type
    const feedbackResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/feedback?insurance_type=eq.${encodeURIComponent(type)}&status=eq.approved&select=*`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const feedbacks = feedbackResponse.ok ? await feedbackResponse.json() : [];

    // Build prompt with type-specific instructions
    let prompt = buildPrompt(companyA, companyB, type, pdfA.full_text, pdfB.full_text, feedbacks);

    console.log(`🔄 Starting analysis: ${companyA} vs ${companyB} for ${type}`);

    // Call Claude API with structured outputs
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: getSystemPrompt(type),
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    // Parse response
    const txt = message.content.map(function(i) { return i.type === 'text' ? i.text : ''; }).join('\n');
    const match = txt.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
    
    if (!match) {
      throw new Error('Failed to parse analysis result');
    }

    const parsed = JSON.parse(match[0]);

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

function buildPrompt(companyA, companyB, type, textA, textB, feedbacks) {
  let prompt = `Sammenlign ${companyA} og ${companyB} for ${type}.

SELSKAB A (${companyA}) BETINGELSER:
${textA.substring(0, 100000)}

SELSKAB B (${companyB}) BETINGELSER:
${textB.substring(0, 100000)}
`;

  if (feedbacks.length > 0) {
    prompt += `\n\nGODKENDT FEEDBACK (VIGTIGT - tag højde for dette):\n`;
    feedbacks.forEach(function(f, i) {
      prompt += `${i + 1}. ${f.category}: ${f.comment}\n`;
    });
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
→ winner=a ← A dækker, B undtager!

## 📊 Status-definitioner (brug KUN disse 3):
- **yes**: Dækkes eksplicit med konkrete vilkår
- **no**: Eksplicit undtaget eller ikke dækket (skriv "ikke dækket" eller lignende i amount felt)
- **inib**: Ikke Nævnt I Betingelserne

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
      "customer_explanation": "Simpel forklaring"
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
