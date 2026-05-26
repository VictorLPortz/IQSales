import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ═══════════════════════════════════════════════════════════════
// JSON SANITIZATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Basic JSON sanitization - fixes common issues
 */
function sanitizeJSON(jsonStr) {
  return jsonStr
    .replace(/,(\s*[}\]])/g, '$1')      // Remove trailing commas
    .replace(/\n/g, ' ')                 // Remove newlines
    .replace(/\r/g, '')                  // Remove carriage returns
    .replace(/\t/g, ' ')                 // Replace tabs with spaces
    .replace(/  +/g, ' ')                // Collapse multiple spaces
    .trim();
}

/**
 * Aggressive JSON cleaning - last resort fallback
 * Fixes unescaped quotes and other critical issues
 */
function aggressiveJSONClean(jsonStr) {
  let cleaned = jsonStr;
  
  // Step 1: Remove trailing commas (again, to be safe)
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
  
  // Step 2: Fix unescaped quotes inside string values
  // Match "key": "value with "quotes" inside"
  // This is VERY aggressive - only use as fallback
  cleaned = cleaned.replace(
    /"([^"]+)":\s*"([^"]*)"/g,
    function(match, key, value) {
      // Escape internal quotes in the value
      const escapedValue = value
        .replace(/\\"/g, 'TEMP_ESCAPED_QUOTE')  // Protect already escaped
        .replace(/"/g, '\\"')                    // Escape unescaped quotes
        .replace(/TEMP_ESCAPED_QUOTE/g, '\\"'); // Restore
      return `"${key}": "${escapedValue}"`;
    }
  );
  
  // Step 3: Remove control characters
  cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, ' ');
  
  // Step 4: Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  return cleaned;
}

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

    // Special instructions for Rejseforsikring to avoid JSON errors
    if (type === 'Rejseforsikring') {
      prompt += `\n\n🚨 EKSTRA VIGTIGT FOR REJSEFORSIKRING:

⚠️ HUSK CATEGORY FELTET - det er OBLIGATORISK!
- HVER coverage item SKAL have et konkret "category" navn
- Eksempler: "Sygdom og tilskadekomst", "Tandlæge", "Hjemtransport", "Bagage forsinkelse"
- ALDRIG lad category være tom eller undefined
- ALDRIG send bare punkt, a, b uden category

JSON REGLER (for at undgå parse fejl):
- UNDGÅ ALLE QUOTES i amount_a og amount_b felter
- Skriv Zone 1 UDEN quotes (ikke "Zone 1")
- Skriv tallene uden punktum: 50000 (ikke 50.000)
- Hold alle reason felter under 60 tegn
- Brug simple ord uden special chars`;
    }
    
    // Add max items limit for all types with prioritization rules
    const maxItems = 20; // Standard max for all types
    
    prompt += `\n\n⚠️ VIGTIGT: Returner MAX ${maxItems} coverage items for ${type}.

PRIORITÉR I DENNE RÆKKEFØLGE:
1. Store beløbsforskelle (f.eks. 50.000 kr vs 100.000 kr)
2. Dækninger hvor kun ÉT selskab dækker (status: yes vs no)
3. Markant bedre vilkår (f.eks. selvrisiko 2.500 kr vs 5.000 kr)
4. Kritiske dækninger som kunden ofte spørger om
5. Unikke fordele ved dit selskab (winner=a)

SPRING OVER:
- Mindre forskelle under 5.000 kr
- Dækninger hvor begge selskaber er næsten ens
- Tekniske detaljer uden praktisk betydning
- Ansvarsforsikring (medmindre stor forskel)

Vælg de ${maxItems} dækninger der giver STØRST værdi i salgssituationen!`;

    prompt += `\n\nReturner JSON med: type, companyA, companyB, coverage (array af dækningspunkter), pitch (salgsargumenter), top3_a, top3_b.`;

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
          max_tokens: 8000,
          system: getSystemPrompt(attempt > 1), // Use stricter prompt on retry
          messages: [{
            role: 'user',
            content: prompt
          }]
        });
        
        break; // Success - exit retry loop
        
      } catch (apiError) {
        console.error(`❌ API attempt ${attempt} failed:`, apiError.message);
        
        if (attempt >= maxAttempts) {
          throw new Error(`Claude API fejlede efter ${maxAttempts} forsøg: ${apiError.message}`);
        }
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Parse response
    const txt = message.content.map(function(i) { return i.type === 'text' ? i.text : ''; }).join('\n');
    let cleanedText = txt.replace(/```json|```/g, '').trim();
    
    // ✨ FORBEDRET: Extract first complete JSON object using bracket matching
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
          // Found complete JSON object!
          jsonStr = cleanedText.substring(startIndex, i + 1);
          break;
        }
      }
    }
    
    if (!jsonStr) {
      console.error('❌ No complete JSON object found in response');
      console.error('Response text:', txt.substring(0, 500));
      throw new Error('Claude returnerede ikke valid JSON format');
    }
    
    // ✨ ROBUST JSON SANITIZATION
    jsonStr = sanitizeJSON(jsonStr);
    
    // ✨ FORBEDRET: Try/catch med detaljeret error logging
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error('❌ JSON Parse Error:', parseError.message);
      console.error('❌ Error position:', parseError.message.match(/position (\d+)/)?.[1]);
      console.error('❌ JSON length:', jsonStr.length);
      
      // Log context around error position
      const posMatch = parseError.message.match(/position (\d+)/);
      if (posMatch) {
        const pos = parseInt(posMatch[1]);
        const start = Math.max(0, pos - 100);
        const end = Math.min(jsonStr.length, pos + 100);
        console.error('❌ Context around error:');
        console.error(jsonStr.substring(start, end));
      }
      
      // ✨ FALLBACK: Try aggressive cleaning
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

    console.log('✅ JSON parsed successfully');

    // ✨ NORMALIZE DATA: Fix incorrect field names from Claude
    if (parsed.coverage && Array.isArray(parsed.coverage)) {
      parsed.coverage = parsed.coverage.map(item => {
        // Generate reason if missing
        let autoReason = item.reason || item.note || null;
        if (!autoReason && item.winner && item.winner !== 'equal' && item.winner !== 'tie') {
          const winnerName = item.winner === 'a' ? companyA : companyB;
          autoReason = `${winnerName} har bedre dækning`;
        }
        
        // NORMALIZE AMOUNT FIELDS - convert objects to strings
        let normalizedAmountA = item.amount_a;
        let normalizedAmountB = item.amount_b;
        
        // If amount_a is an object, extract the details string
        if (normalizedAmountA && typeof normalizedAmountA === 'object') {
          // Handle both "details" and "detail" keys
          const detailText = normalizedAmountA.details || normalizedAmountA.detail;
          
          if (normalizedAmountA.covered === false) {
            normalizedAmountA = detailText || 'Ikke dækket';
          } else if (normalizedAmountA.covered === true) {
            normalizedAmountA = detailText || 'Dækket';
          } else {
            normalizedAmountA = detailText || JSON.stringify(normalizedAmountA);
          }
        }
        
        // If amount_b is an object, extract the details string
        if (normalizedAmountB && typeof normalizedAmountB === 'object') {
          // Handle both "details" and "detail" keys
          const detailText = normalizedAmountB.details || normalizedAmountB.detail;
          
          if (normalizedAmountB.covered === false) {
            normalizedAmountB = detailText || 'Ikke dækket';
          } else if (normalizedAmountB.covered === true) {
            normalizedAmountB = detailText || 'Dækket';
          } else {
            normalizedAmountB = detailText || JSON.stringify(normalizedAmountB);
          }
        }
        
        // Create normalized item
        const normalized = {
          category: item.category || item.punkt || 'Ukendt dækning',
          status_a: item.status_a || (item.a ? 'yes' : 'inib'),
          status_b: item.status_b || (item.b ? 'yes' : 'inib'),
          amount_a: normalizedAmountA || item.a || null,
          amount_b: normalizedAmountB || item.b || null,
          winner: item.winner === 'tie' ? 'equal' : (item.winner || 'equal'),
          reason: autoReason || 'Ingen yderligere detaljer',
          sales_tip: item.sales_tip || '',
          objection_tip: item.objection_tip || '',
          customer_explanation: item.customer_explanation || ''
        };
        return normalized;
      });
      console.log('✅ Normalized', parsed.coverage.length, 'coverage items');
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

function getSystemPrompt(isRetry = false) {
  let prompt = `Du er Danmarks mest erfarne forsikringsekspert med 20+ års erfaring i at sammenligne forsikringsbetingelser.

# ⚠️ CRITICAL: JSON FORMATTING RULES (FØLG DISSE STRENGT!)

Du SKAL returnere 100% VALID JSON. Følg disse regler NØJE:

1. **ESCAPE ALL QUOTES I STRINGS:**
   ✅ KORREKT: "amount_a": "Dækker \\"stormskader\\" op til 50.000 kr"
   ❌ FORKERT: "amount_a": "Dækker "stormskader" op til 50.000 kr"

2. **INGEN LINE BREAKS I JSON STRINGS:**
   ✅ KORREKT: "reason": "Linje 1. Linje 2."
   ❌ FORKERT: "reason": "Linje 1
                           Linje 2"

3. **ESCAPE SPECIAL CHARS:**
   - Backslash: \\\\ → \\\\\\\\
   - Quote: " → \\"
   - Newline: Brug mellemrum eller . i stedet

4. **HVIS I TVIVL - UNDLAD QUOTES:**
   ✅ SIKKERT: "amount_a": "Dækker stormskader op til 50000 kr"
   ❌ RISIKABELT: "amount_a": "Dækker "stormskader" op til 50.000"

5. **TEST MENTALT:**
   Før du returnerer JSON, spørg dig selv: "Ville JSON.parse() acceptere dette?"
   Hvis nej → ret det!`;

  // Add EXTRA STRICT rules on retry
  if (isRetry) {
    prompt += `

# 🚨 EXTRA STRENGE REGLER (DETTE ER ET RETRY!)

Dit forrige forsøg fejlede JSON parsing. Følg disse EKSTRA regler:

1. **BRUG ALDRIG QUOTES I VÆRDIER:**
   - Skriv IKKE: "Dækker "Zone 1" og "Zone 2""
   - Skriv I STEDET: "Dækker Zone 1 og Zone 2"
   
2. **SIMPLIFICER AL TEKST:**
   - Hold reason felter under 80 tegn
   - Brug simple ord uden anførselstegn
   
3. **DOUBLE-CHECK HVER LINJE:**
   - Læs JSON en ekstra gang før du sender
   - Hvis du ser " inde i en string → FJERN DET!`;
  }

  prompt += `

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
⚠️ KRITISK: Hver coverage entry SKAL have PRÆCIS disse felter - ikke andre!

🔥 EKSTRA VIGTIGT - CATEGORY FELT:
- HVER coverage item SKAL have et konkret "category" navn
- Eksempler: "Stormskade", "Selvrisiko brand", "Hundesygdom", "Vognmandskørsel"  
- ALDRIG lad category være tom, undefined, eller generisk som "Ukendt dækning" eller "Ekstra dækning" eller bare "Bygning"
- ALDRIG send bare punkt, a, b uden category
- Brug konkrete, specifikke navne for hver dækning
- Hvis du finder flere forskelle inden for samme kategori, DIFFERENTIER dem: "Bygning - Solceller", "Bygning - Stormskade", etc.

🔥 EKSTRA VIGTIGT - AMOUNT FELTER SKAL VÆRE STRINGS:
- amount_a og amount_b SKAL ALTID være TEXT STRINGS - ALDRIG objects!
- ✅ KORREKT: "amount_a": "Ingen nyværdierstatning"
- ✅ KORREKT: "amount_a": "Nyværdierstatning første år hvis fabriksny"
- ❌ FORKERT: "amount_a": {"covered": false, "details": "..."}
- ❌ FORKERT: "amount_a": {covered: true, details: "..."}
- Hvis status er "inib" eller "no", sæt amount til null
- Hvis status er "yes", skriv dækningen som EN TEXT STRING

Returner KUN valid JSON uden markdown backticks:
{
  "type": "Husforsikring",
  "companyA": "Alm. Brand",
  "companyB": "Tryg",
  "coverage": [
    {
      "category": "Navn på dækning",
      "status_a": "yes/no/inib",       ← VIGTIGT: status_a (ikke bare "a")
      "status_b": "yes/no/inib",       ← VIGTIGT: status_b (ikke bare "b")
      "amount_a": "Beløb eller vilkår", ← VIGTIGT: amount_a MÅ KUN VÆRE STRING!
      "amount_b": "Beløb eller vilkår", ← VIGTIGT: amount_b MÅ KUN VÆRE STRING!
      "winner": "a/b/equal",
      "reason": "Forklaring på hvorfor", ← VIGTIGT: reason (ikke "note")
      "sales_tip": "Max 1 sætning salgstip hvis winner=a, ellers tom streng",
      "objection_tip": "Max 1 sætning håndtering af indsigelse hvis winner=b, ellers tom streng",
      "customer_explanation": "Max 1 sætning i simpelt dansk"
    }
  ],
  "pitch": {
    "why_switch": "Hvorfor skifte?",
    "money_saved": "Besparelse"
  },
  "top3_a": ["Fordel 1", "Fordel 2", "Fordel 3"],
  "top3_b": ["Fordel 1", "Fordel 2", "Fordel 3"]
}

⚠️ HUSK: Brug status_a, status_b, amount_a, amount_b, reason - IKKE a, b, note!
⚠️ HUSK: amount_a og amount_b må KUN være strings eller null - ALDRIG objects!`;
}
