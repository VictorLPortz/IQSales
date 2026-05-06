// ========================================
// api/compare.js
// Sammenligner to forsikringsselskaber
// ========================================

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function POST(req) {
  try {
    const { prompt } = await req.json();
    
    if (!prompt) {
      return Response.json({ 
        error: 'Missing prompt' 
      }, { status: 400 });
    }
    
    console.log('🚀 Comparing insurance companies with prompt length:', prompt.length);
    
    // Send til Claude
    const message = await anthropic.messages.create({
model: 'claude-3-5-haiku-20241022',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });
    
    console.log('✅ Claude response received');
    
    return Response.json({
      content: message.content,
      usage: message.usage
    });
    
  } catch (error) {
    console.error('❌ Comparison failed:', error);
    return Response.json({ 
      error: error.message 
    }, { status: 500 });
  }
}
