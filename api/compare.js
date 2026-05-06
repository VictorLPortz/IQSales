// ========================================
// api/compare.js
// Sammenligner to forsikringsselskaber
// ========================================

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { prompt } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ 
        error: 'Missing prompt' 
      });
    }
    
    console.log('🚀 Comparing insurance companies with prompt length:', prompt.length);
    
    // Send til Claude
    const message = await anthropic.messages.create({
 model: 'claude-3-haiku-20240307',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });
    
    console.log('✅ Claude response received');
    
    return res.status(200).json({
      content: message.content,
      usage: message.usage
    });
    
  } catch (error) {
    console.error('❌ Comparison failed:', error);
    return res.status(500).json({ 
      error: error.message 
    });
  }
}
