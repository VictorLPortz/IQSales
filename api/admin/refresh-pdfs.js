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

Returner kun den faktiske information fra dokumentet i struktureret format.`
        }
      ]
    }]
  });

  return message.content[0].text;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { authorization } = req.headers;
    const token = authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    
    if (!profile || profile.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    
    console.log(`PDF refresh started by: ${user.email}`);
    
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(process.cwd(), 'config', 'pdf-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    
    let totalProcessed = 0;
    let successful = 0;
    let failed = 0;
    let totalCost = 0;
    
    for (const item of config.pdfs) {
      try {
        console.log(`Processing: ${item.selskab} - ${item.produkt_type}`);
        
        const pdfBase64 = await downloadPDF(item.url);
        const parsedData = await parsePDFWithClaude(pdfBase64, item.selskab, item.produkt_type);
        
        await supabase
          .from('insurance_terms')
          .upsert({
            selskab: item.selskab,
            produkt_type: item.produkt_type,
            full_text: parsedData,
            parsed_at: new Date().toISOString(),
          }, {
            onConflict: 'selskab,produkt_type'
          });
        
        successful++;
        totalCost += 0.20;
        
      } catch (error) {
        console.error(`Failed: ${item.selskab} ${item.produkt_type}:`, error);
        failed++;
      }
      
      totalProcessed++;
    }
    
    return res.status(200).json({
      success: true,
      message: `PDF refresh completed: ${successful} successful, ${failed} failed`,
      stats: {
        total: totalProcessed,
        successful,
        failed,
        cost: `$${totalCost.toFixed(2)}`,
      }
    });
    
  } catch (error) {
    console.error('Refresh failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
