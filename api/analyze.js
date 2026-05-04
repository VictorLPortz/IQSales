// ========================================
// analyze-endpoint.js (UPDATED)
// Bruger pre-parsed data fra database
// ========================================

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===================
// MAIN ENDPOINT
// ===================

export async function POST(req) {
  try {
    const { 
      police_data,      // Kundens police PDF (base64)
      selskab,          // 'alm_brand', 'codan', 'privatsikring'
      produkt_type      // 'hus', 'bil', etc.
    } = await req.json();
    
    // 1. Hent pre-parsed betingelser fra database
    console.log(`📚 Fetching pre-parsed data for ${selskab} ${produkt_type}...`);
    
    const { data: insuranceTerms, error } = await supabase
      .from('insurance_terms')
      .select('parsed_data, parsed_at')
      .eq('selskab', selskab)
      .eq('produkt_type', produkt_type)
      .single();
    
    if (error || !insuranceTerms) {
      throw new Error(`No pre-parsed data found for ${selskab} ${produkt_type}`);
    }
    
    console.log(`✅ Found pre-parsed data from ${insuranceTerms.parsed_at}`);
    
    // 2. Analyser police med Claude + pre-parsed data
    const analysis = await analyzeWithClaude(
      police_data,
      insuranceTerms.parsed_data,
      selskab,
      produkt_type
    );
    
    // 3. Gem analyse i database
    const savedAnalysis = await saveAnalysis({
      selskab,
      produkt_type,
      police_data,
      analysis,
      used_preparsed: true,
      preparsed_version: insuranceTerms.parsing_version
    });
    
    return Response.json({
      success: true,
      analysis_id: savedAnalysis.id,
      analysis,
      used_preparsed_data: true,
      preparsed_data_date: insuranceTerms.parsed_at
    });
    
  } catch (error) {
    console.error('Analysis failed:', error);
    return Response.json({ 
      success: false, 
      error: error.message 
    }, { status: 500 });
  }
}

// ===================
// CLAUDE ANALYSIS
// ===================

async function analyzeWithClaude(policeData, preparsedTerms, selskab, produktType) {
  
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: policeData
          }
        },
        {
          type: 'text',
          content: `Du er ekspert i danske forsikringer.

JOB: Analyser kundens police og sammenlign med selskabets betingelser.

KUNDENS POLICE:
Se vedhæftet PDF ovenfor.

SELSKAB: ${selskab}
PRODUKT: ${produktType}

FORSIKRINGSBETINGELSER (pre-parsed):
${JSON.stringify(preparsedTerms, null, 2)}

RETURNER JSON:
{
  "police_dækninger": ["hvad policen dækker"],
  "gaps": {
    "mangler": ["ting policen IKKE dækker, men burde"],
    "risici": ["potentielle risici kunden ikke er dækket for"]
  },
  "anbefalinger": [
    {
      "type": "tilføj_dækning" | "forøg_sum" | "reducer_selvrisiko",
      "beskrivelse": "hvad skal ændres",
      "begrundelse": "hvorfor",
      "prioritet": "høj" | "middel" | "lav"
    }
  ],
  "score": {
    "total": 0-100,
    "kategorier": {
      "dækningsgrad": 0-100,
      "selvrisiko": 0-100,
      "priceValue": 0-100
    }
  }
}

Svar KUN med JSON.`
        }
      ]
    }]
  });
  
  const analysisText = message.content[0].text;
  const analysis = JSON.parse(analysisText);
  
  // Add cost info
  analysis._meta = {
    tokens_used: message.usage.input_tokens + message.usage.output_tokens,
    cost_usd: calculateCost(message.usage)
  };
  
  return analysis;
}

function calculateCost(usage) {
  const inputCost = (usage.input_tokens / 1_000_000) * 3;
  const outputCost = (usage.output_tokens / 1_000_000) * 15;
  return inputCost + outputCost;
}

async function saveAnalysis(data) {
  const { data: saved } = await supabase
    .from('analyses')
    .insert({
      selskab: data.selskab,
      produkt_type: data.produkt_type,
      police_data: data.police_data,
      analysis: data.analysis,
      used_preparsed_data: true,
      preparsed_data_version: data.preparsed_version
    })
    .select()
    .single();
  
  return saved;
}
