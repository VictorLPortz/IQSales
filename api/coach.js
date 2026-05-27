import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { system, message, max_tokens } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message required' });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: max_tokens || 600,
      system: system || 'Du er en erfaren dansk forsikringssælger. Svar kort og praktisk på dansk.',
      messages: [{ role: 'user', content: message }]
    });

    const text = response.content.map(c => c.type === 'text' ? c.text : '').join('');
    return res.status(200).json({ text });

  } catch (error) {
    console.error('Coach API error:', error);
    return res.status(500).json({ error: error.message || 'Coach API failed' });
  }
}
