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

    // Build prompt
    let prompt = `Sammenlign ${companyA} og ${companyB} for ${type}.

SELSKAB A (${companyA}) BETINGELSER:
${pdfA.full_text.substring(0, 100000)}

SELSKAB B (${companyB}) BETINGELSER:
${pdfB.full_text.substring(0, 100000)}
`;

    if (feedbacks.length > 0) {
      prompt += `\n\nGODKENDT FEEDBACK (VIGTIGT - tag højde for dette):\n`;
      feedbacks.forEach(function(f, i) {
        prompt += `${i + 1}. ${f.category}: ${f.comment}\n`;
      });
    }

    prompt += `\n\nReturner JSON med: type, companyA, companyB, coverage (array af dækningspunkter), pitch (salgsargumenter), top3_a, top3_b.`;

    // Call Claude API
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: getSystemPrompt(),
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

function getSystemPrompt() {
  return `Du er Danmarks mest erfarne forsikringsekspert med 20+ års erfaring i at sammenligne forsikringsbetingelser.

# DIN OPGAVE
Analyser de to sæt forsikringsbetingelser MEGET nøje og identificer præcist hvad hvert selskab dækker og IKKE dækker.

# KRITISKE REGLER FOR SAMMENLIGNING

## ✅ REGEL 1: Højere beløb = Fordel
Hvis Selskab A dækker 50.000 kr og Selskab B dækker 100.000 kr → winner=b
Eksempel: 
- A: "Personskade: 50.000 kr"
- B: "Personskade: 100.000 kr"
- → winner=b, reason="B dækker dobbelt så meget"

## ✅ REGEL 2: Kun én nævner dækningen = Fordel
Hvis Selskab A nævner "blæsevejr" og Selskab B ikke gør → winner=a
VIGTIGT: Dette gælder MEDMINDRE Selskab B eksplicit undtager det.
Eksempel:
- A: "Dækker blæsevejr under vindstyrke 8"
- B: Nævner ikke blæsevejr
- → winner=a, reason="A dækker blæsevejr, ikke nævnt hos B"

## ✅ REGEL 3: Bedre vilkår = Fordel
Lavere selvrisiko, længere periode, bredere geografi, færre begrænsninger = Fordel
Eksempel:
- A: "Selvrisiko 2.500 kr"
- B: "Selvrisiko 5.000 kr"  
- → winner=a, reason="Halvt så lav selvrisiko"

## ⚖️ REGEL 4: Vage beløb = Equal
"50.000 kr" vs "fremgår af police" → winner=equal (kan ikke sammenlignes)
Eksempel:
- A: "Maksimal dækning: 100.000 kr"
- B: "Dækning fremgår af police"
- → winner=equal, reason="Kan ikke sammenlignes - B ikke specificeret"

## 🚫 REGEL 5: UDELAD kun Ansvarsforsikring
Returner IKKE Ansvarsforsikring MEDMINDRE der er konkret forskel i beløb eller vilkår.
INKLUDER ALT ANDET hvor der er forskel - blæsevejr, tyveri, brand, personskade, osv.

## 📊 Status-definitioner (brug KUN disse 3):
- **yes**: Dækkes eksplikt med konkrete vilkår
- **no**: Eksplicit undtaget eller udelukket
- **inib**: INIB (Ikke Nævnt I Betingelserne) - dækningen nævnes slet ikke

VIGTIGT: Der findes IKKE "partial" status! Hvis noget dækkes med begrænsninger, brug "yes" og forklar begrænsningen i reason.

# EKSEMPEL 1: Højere beløb
{
  "category": "Personskade",
  "status_a": "yes",
  "status_b": "yes", 
  "amount_a": "50.000 kr",
  "amount_b": "100.000 kr",
  "winner": "b",
  "reason": "Selskab B dækker dobbelt så meget som Selskab A"
}

# EKSEMPEL 2: Kun én nævner
{
  "category": "Blæsevejr",
  "status_a": "yes",
  "status_b": "inib",
  "amount_a": "Dækkes under vindstyrke 8",
  "amount_b": null,
  "winner": "a",
  "reason": "Kun Selskab A dækker blæsevejr - ikke nævnt hos B"
}

# EKSEMPEL 3: Begge dækker ens
{
  "category": "Brand i bolig",
  "status_a": "yes",
  "status_b": "yes",
  "amount_a": "Fuld dækning",
  "amount_b": "Fuld dækning",
  "winner": "equal",
  "reason": "Begge selskaber dækker brand fuldt ud"
}

# EKSEMPEL 4: Bedre vilkår
{
  "category": "Retshjælp",
  "status_a": "yes",
  "status_b": "yes",
  "amount_a": "Op til 225.000 kr, selvrisiko 2.500 kr",
  "amount_b": "Op til 225.000 kr, selvrisiko 5.000 kr",
  "winner": "a",
  "reason": "Samme dækningssum men A har halvt så lav selvrisiko"
}

# OUTPUT FORMAT
Returner KUN valid JSON uden markdown backticks:
{
  "type": "Husforsikring",
  "companyA": "Alm. Brand",
  "companyB": "Tryg",
  "coverage": [
    {
      "category": "Navn på dækning",
      "status_a": "yes/no/inib",
      "status_b": "yes/no/inib",
      "amount_a": "Beløb eller vilkår",
      "amount_b": "Beløb eller vilkår",
      "winner": "a/b/equal",
      "reason": "Forklaring på hvorfor"
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
