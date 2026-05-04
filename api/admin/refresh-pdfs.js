const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function downloadPDF(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download PDF: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer).toString('base64');
}

async function parsePDFWithClaude(pdfBase64, selskab, produktType) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20241022',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: pdfBase64,
          },
        },
        {
          type: 'text',
          text: `Ekstraher følgende information fra denne ${produktType} forsikringsbetingelse fra ${selskab}:

1. Selvrisiko beløb (find alle niveauer)
2. Dækningssummer (maksimale erstatningsbeløb)
3. Særlige vilkår og begrænsninger
4. Hvad er IKKE dækket
5. Ventetider eller karensperioder

Returner kun den faktiske information fra dokumentet i s
