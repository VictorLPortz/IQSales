import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function POST(req) {
  try {
    const { prompt } = await req.json();
    
    console.log('📥 Received prompt, length:', prompt?.length || 0);
    
    if (!prompt) {
      throw new Error('No prompt provided');
    }
    
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });
    
    console.log('✅ Claude response received');
    
    return Response.json({
      content: message.content
    });
    
  } catch (error) {
    console.error('❌ API Error:', error);
    return Response.json({ 
      error: error.message 
    }, { status: 500 });
  }
}
