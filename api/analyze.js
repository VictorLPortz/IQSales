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
      return res.status(400).json({ error: 'Prompt required' });
    }

    const message = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-latest',
    max_tokens: 4000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    return res.status(200).json({
      content: message.content
    });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ 
      error: error.message || 'Analysis failed'
    });
  }
}
