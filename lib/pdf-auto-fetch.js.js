// ========================================
// pdf-auto-fetch.js
// Cron job der kører ugentligt
// ========================================

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import pdfParse from 'pdf-parse';

// ===================
// CONFIG
// ===================

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PDF_CONFIG_PATH = './config/pdf-config.json';
const TEMP_PDF_DIR = './temp_pdfs';

// ===================
// MAIN FUNCTION
// ===================

async function runWeeklyPdfRefresh() {
  console.log('🚀 Starting weekly PDF refresh...');
  
  const jobId = await createParsingJob('weekly_refresh');
  
  try {
    // 1. Load PDF configuration
    const config = JSON.parse(await fs.readFile(PDF_CONFIG_PATH, 'utf-8'));
    
    // 2. Create temp directory
    await fs.mkdir(TEMP_PDF_DIR, { recursive: true });
    
    let stats = {
      totalPdfs: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
      totalTokens: 0,
      totalCost: 0,
    };
    
    // 3. Process each selskab
    for (const selskab of config.selskaber) {
      console.log(`\n📦 Processing: ${selskab.navn}`);
      
      for (const produkt of selskab.produkter) {
        stats.totalPdfs++;
        
        try {
          // Download PDF
          const pdfPath = await downloadPdf(
            produkt.url,
            selskab.kode,
            produkt.type
          );
          
          // Check if PDF changed (compare hash)
          const pdfHash = await calculateFileHash(pdfPath);
          const hasChanged = await checkIfPdfChanged(
            selskab.kode,
            produkt.type,
            pdfHash
          );
          
          if (!hasChanged) {
            console.log(`   ⏭️  Skipped ${produkt.navn} (unchanged)`);
            stats.skipped++;
            await logPdfDownload(selskab.kode, produkt, 'skipped', null);
            continue;
          }
          
          // Parse PDF with Claude
          console.log(`   🔄 Parsing ${produkt.navn}...`);
          const parseResult = await parsePdfWithClaude(
            pdfPath,
            selskab.navn,
            produkt.navn,
            produkt.type
          );
          
          // Save to database
          await saveP arsedData(
            selskab.kode,
            produkt.type,
            produkt.url,
            pdfHash,
            parseResult.data
          );
          
          stats.successful++;
          stats.totalTokens += parseResult.tokensUsed;
          stats.totalCost += parseResult.cost;
          
          console.log(`   ✅ ${produkt.navn} - ${parseResult.tokensUsed} tokens`);
          
          await logPdfDownload(selskab.kode, produkt, 'success', null);
          
        } catch (error) {
          console.error(`   ❌ Failed: ${produkt.navn}`, error.message);
          stats.failed++;
          await logPdfDownload(selskab.kode, produkt, 'failed', error.message);
        }
      }
    }
    
    // 4. Update job status
    await completeParsingJob(jobId, stats);
    
    // 5. Cleanup temp directory
    await fs.rm(TEMP_PDF_DIR, { recursive: true, force: true });
    
    console.log('\n✅ Weekly PDF refresh completed!');
    console.log(`📊 Stats: ${stats.successful} successful, ${stats.failed} failed, ${stats.skipped} skipped`);
    console.log(`💰 Total cost: $${stats.totalCost.toFixed(2)}`);
    
    return stats;
    
  } catch (error) {
    console.error('❌ Job failed:', error);
    await failParsingJob(jobId, error);
    throw error;
  }
}

// ===================
// HELPER FUNCTIONS
// ===================

async function downloadPdf(url, selskab, produktType) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  
  const buffer = await response.arrayBuffer();
  const filename = `${selskab}_${produktType}.pdf`;
  const filepath = path.join(TEMP_PDF_DIR, filename);
  
  await fs.writeFile(filepath, Buffer.from(buffer));
  return filepath;
}

async function calculateFileHash(filepath) {
  const content = await fs.readFile(filepath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function checkIfPdfChanged(selskab, produktType, newHash) {
  const { data } = await supabase
    .from('insurance_terms')
    .select('pdf_hash')
    .eq('selskab', selskab)
    .eq('produkt_type', produktType)
    .single();
  
  return !data || data.pdf_hash !== newHash;
}

async function parsePdfWithClaude(pdfPath, selskabNavn, produktNavn, produktType) {
  // Extract text from PDF
  const pdfBuffer = await fs.readFile(pdfPath);
  const pdfData = await pdfParse(pdfBuffer);
  const pdfText = pdfData.text;
  
  // Truncate if too long (Claude has limits)
  const maxChars = 180000; // ~50k tokens
  const truncatedText = pdfText.slice(0, maxChars);
  
  // Parse with Claude
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: `Du er ekspert i at analysere danske forsikringsbetingelser.

Ekstrahér de vigtigste informationer fra denne ${produktNavn} fra ${selskabNavn}.

PDF BETINGELSER:
${truncatedText}

Returner et JSON-objekt med følgende struktur:
{
  "dækninger": {
    "hvad_er_dækket": ["liste af ting der er dækket"],
    "hvad_er_ikke_dækket": ["liste af undtagelser"]
  },
  "selvrisiko": {
    "standard": "beløb",
    "særlige_tilfælde": []
  },
  "erstatning": {
    "max_beløb": "beløb hvis relevant",
    "beregning": "hvordan erstattes der"
  },
  "vigtige_betingelser": ["liste af vigtige betingelser"],
  "særlige_forhold": ["alt andet væsentligt"]
}

Svar KUN med JSON, ingen forklaring.`
    }]
  });
  
  const responseText = message.content[0].text;
  const parsedData = JSON.parse(responseText);
  
  return {
    data: parsedData,
    tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
    cost: calculateCost(message.usage)
  };
}

function calculateCost(usage) {
  const inputCost = (usage.input_tokens / 1_000_000) * 3;  // $3 per 1M input
  const outputCost = (usage.output_tokens / 1_000_000) * 15; // $15 per 1M output
  return inputCost + outputCost;
}

async function saveParsedData(selskab, produktType, pdfUrl, pdfHash, parsedData) {
  await supabase
    .from('insurance_terms')
    .upsert({
      selskab,
      produkt_type: produktType,
      pdf_url: pdfUrl,
      pdf_hash: pdfHash,
      parsed_data: parsedData,
      downloaded_at: new Date().toISOString(),
      parsed_at: new Date().toISOString(),
      parsing_version: '1.0'
    }, {
      onConflict: 'selskab,produkt_type'
    });
}

async function logPdfDownload(selskab, produkt, status, errorMessage) {
  await supabase.from('pdf_download_log').insert({
    selskab,
    produkt_type: produkt.type,
    pdf_url: produkt.url,
    status,
    error_message: errorMessage
  });
}

async function createParsingJob(jobType) {
  const { data } = await supabase
    .from('parsing_log')
    .insert({ job_type: jobType })
    .select()
    .single();
  return data.id;
}

async function completeParsingJob(jobId, stats) {
  await supabase
    .from('parsing_log')
    .update({
      completed_at: new Date().toISOString(),
      total_pdfs: stats.totalPdfs,
      successful_parses: stats.successful,
      failed_parses: stats.failed,
      total_tokens_used: stats.totalTokens,
      total_cost_usd: stats.totalCost,
      status: 'completed'
    })
    .eq('id', jobId);
}

async function failParsingJob(jobId, error) {
  await supabase
    .from('parsing_log')
    .update({
      completed_at: new Date().toISOString(),
      status: 'failed',
      error_details: { message: error.message, stack: error.stack }
    })
    .eq('id', jobId);
}

// ===================
// RUN
// ===================

runWeeklyPdfRefresh().catch(console.error);
