import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { insurance_type } = req.body;
    
    if (!insurance_type) {
      return res.status(400).json({ error: 'insurance_type required' });
    }

    console.log(`🔄 Starting regeneration for ${insurance_type}...`);

    // Find all caches for this insurance type
    const { data: caches, error: cacheError } = await supabase
      .from('analysis_cache')
      .select('*')
      .eq('insurance_type', insurance_type);

    if (cacheError) {
      console.error('Error fetching caches:', cacheError);
      return res.status(500).json({ error: 'Failed to fetch caches' });
    }

    console.log(`📊 Found ${caches.length} caches to regenerate`);

    // Regenerate each cache
    let successCount = 0;
    let errorCount = 0;

    for (const cache of caches) {
      try {
        await regenerateSingleCache(cache);
        successCount++;
        console.log(`✅ Regenerated: ${cache.company_a} vs ${cache.company_b}`);
      } catch (error) {
        errorCount++;
        console.error(`❌ Failed: ${cache.company_a} vs ${cache.company_b}:`, error.message);
      }
    }

    console.log(`🎉 Regeneration complete: ${successCount} success, ${errorCount} errors`);

    return res.status(200).json({
      success: true,
      total: caches.length,
      success_count: successCount,
      error_count: errorCount
    });

  } catch (error) {
    console.error('❌ Regeneration failed:', error);
    return res.status(500).json({ 
      error: error.message || 'Regeneration failed'
    });
  }
}

async function regenerateSingleCache(cache) {
  // 1. Hent PDFs fra insurance_terms
  const { data: pdfA, error: errorA } = await supabase
    .from('insurance_terms')
    .select('full_text, pdf_hash')
    .eq('selskab', cache.company_a)
    .eq('produkt_type', cache.insurance_type)
    .single();

  const { data: pdfB, error: errorB } = await supabase
    .from('insurance_terms')
    .select('full_text, pdf_hash')
    .eq('selskab', cache.company_b)
    .eq('produkt_type', cache.insurance_type)
    .single();

  if (errorA || errorB || !pdfA || !pdfB) {
    throw new Error('PDFs not found in insurance_terms');
  }

  // 2. Hent godkendt feedback
  const { data: feedbacks } = await supabase
    .from('feedback')
    .select('*')
    .eq('insurance_type', cache.insurance_type)
    .eq('status', 'approved');

  // 3. Byg prompt (samme som i index.html)
  const prompt = buildAnalysisPrompt(
    cache.company_a,
    cache.company_b,
    cache.insurance_type,
    pdfA.full_text,
    pdfB.full_text,
    feedbacks || []
  );

  // 4. Kald Claude API
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    system: getSystemPrompt(),
    messages: [{
      role: 'user',
      content: prompt
    }]
  });

  // 5. Parse response
  const txt = message.content.map(i => i.type === 'text' ? i.text : '').join('\n');
  const m = txt.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
  
  if (!m) {
    throw new Error('Failed to parse analysis result');
  }

  const parsed = JSON.parse(m[0]);

  // 6. Opdater cache
  const { error: updateError } = await supabase
    .from('analysis_cache')
    .update({ 
      result: parsed,
      created_at: new Date().toISOString() // Update timestamp
    })
    .eq('id', cache.id);

  if (updateError) {
    throw new Error('Failed to update cache');
  }
}

function buildAnalysisPrompt(companyA, companyB, type, textA, textB, feedbacks) {
  let prompt = `Sammenlign ${companyA} og ${companyB} for ${type}.

SELSKAB A (${companyA}) BETINGELSER:
${textA.substring(0, 100000)}

SELSKAB B (${companyB}) BETINGELSER:
${textB.substring(0, 100000)}
`;

  if (feedbacks.length > 0) {
    prompt += `\n\nGODKENDT FEEDBACK (VIGTIGT - tag højde for dette):\n`;
    feedbacks.forEach((f, i) => {
      prompt += `${i + 1}. ${f.category}: ${f.comment}\n`;
    });
  }

  prompt += `\n\nReturner JSON med: type, companyA, companyB, coverage (array af dækningspunkter), pitch (salgsargumenter), top3_a, top3_b.`;

  return prompt;
}

function getSystemPrompt() {
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
"50.000 kr" vs "fremgår af police" → winner=equal (kan ikke sammenlignes)

## 🚫 REGEL 5: UDELAD kun Ansvarsforsikring
Returner IKKE Ansvarsforsikring MEDMINDRE der er konkret forskel.
INKLUDER ALT ANDET hvor der er forskel!

## Status-definitioner
- yes: Dækkes eksplicit
- partial: Dækkes med begrænsninger
- no: Eksplicit undtaget
- inib: Ikke nævnt

Returner KUN valid JSON uden markdown backticks.`;
}
