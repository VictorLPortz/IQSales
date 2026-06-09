import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const INPUT_COST_PER_TOKEN = 0.000003;
const OUTPUT_COST_PER_TOKEN = 0.000015;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { system, message, max_tokens, user_id, section_type } = req.body;

  // Auth check — kræv gyldigt login
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Ikke autoriseret. Log ind for at bruge IQSales.' });
  }
  const token = authHeader.replace('Bearer ', '');
  try {
    const verifyResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` }
    });
    if (!verifyResponse.ok) return res.status(401).json({ error: 'Ugyldig session. Log ind igen.' });
    const userData = await verifyResponse.json();
    if (!userData.id) return res.status(401).json({ error: 'Ugyldig session. Log ind igen.' });
  } catch (e) {
    return res.status(401).json({ error: 'Kunne ikke verificere login.' });
  }



  if (!message) {
    return res.status(400).json({ error: 'message required' });
  }

  const startTime = Date.now();

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: max_tokens || 600,
      system: system || 'Du er en erfaren dansk forsikringssælger. Svar kort og praktisk på dansk.',
      messages: [{ role: 'user', content: message }]
    });

    const text = response.content.map(c => c.type === 'text' ? c.text : '').join('');
    const responseTime = Date.now() - startTime;

    // Log to analytics
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const tokensUsed = inputTokens + outputTokens;
    const costEstimate = (inputTokens * INPUT_COST_PER_TOKEN) + (outputTokens * OUTPUT_COST_PER_TOKEN);

    if (SUPABASE_URL && SUPABASE_KEY) {
      fetch(`${SUPABASE_URL}/rest/v1/analytics`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          user_id: user_id || null,
          event_type: 'coach_' + (section_type || 'chat'),
          insurance_type: 'Salgscoach',
          company_a: null,
          company_b: null,
          cache_used: false,
          response_time_ms: responseTime,
          tokens_used: tokensUsed,
          cost_estimate: costEstimate
        })
      }).catch(err => console.error('Analytics log failed:', err));
    }

    return res.status(200).json({ text });

  } catch (error) {
    console.error('Coach API error:', error);
    return res.status(500).json({ error: error.message || 'Coach API failed' });
  }
}
