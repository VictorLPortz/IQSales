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


    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt required' });
    }

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: `Du er Danmarks mest erfarne forsikringsekspert med 20+ års erfaring i at sammenligne forsikringsbetingelser.

# DIN OPGAVE
Analyser de to sæt forsikringsbetingelser MEGET nøje og identificer præcist hvad hvert selskab dækker og IKKE dækker.

# KRITISKE REGLER FOR SAMMENLIGNING

## ✅ REGEL 1: Højere beløb = Fordel
Hvis Selskab A dækker 50.000 kr og Selskab B dækker 100.000 kr → winner=b

## ✅ REGEL 2: Kun én nævner dækningen = Fordel
Hvis Selskab A nævner "blæsevejr" og Selskab B ikke gør → winner=a
VIGTIGT: Dette gælder MEDMINDRE Selskab B eksplicit undtager det.

## ✅ REGEL 3: Bedre vilkår = Fordel
Lavere selvrisiko, længere periode, bredere geografi = Fordel

## ⚖️ REGEL 4: Vage beløb = Equal
"50.000 kr" vs "fremgår af police" → winner=equal (kan ikke sammenlignes)

## Status-definitioner
- **yes**: Dækkes eksplicit med konkrete beløb/vilkår
- **partial**: Dækkes med begrænsninger (kræver tilvalg, geografisk, tidsmæssigt)
- **no**: Eksplicit fravalgt eller undtaget
- **inib**: Ikke nævnt i betingelserne (betyder IKKE at det ikke dækkes)

## Winner-logik
- **winner=a**: A er bedre (højere beløb, bedre vilkår, eller A nævner det/B gør ikke)
- **winner=b**: B er bedre (højere beløb, bedre vilkår, eller B nævner det/A gør ikke)
- **winner=equal**: Lige gode, eller ikke sammenlignelige

# EKSEMPLER

**Eksempel 1: Klar fordel**
A: "Vejhjælp op til 100 km"
B: "Vejhjælp op til 50 km"
→ winner=a (dobbelt så langt)

**Eksempel 2: Kun én nævner**
A: "Blæsevejr dækket"
B: [nævner ikke]
→ winner=a, b_status=inib

**Eksempel 3: Vagt beløb**
A: "25.000 kr"
B: "fremgår af police"
→ winner=equal

**Eksempel 4: Undtagelse**
A: "Kosmetisk skade dækket"
B: "Kosmetisk skade undtaget"
→ winner=a, b_status=no

# VIGTIGE PÅMINDELSER
1. Læs HELE betingelserne nøje
2. Brug konkrete beløb fra teksten
3. Vær præcis med vilkår
4. Hvis begge er lige gode, sig det
5. Find 8-10 vigtige dækningspunkter
6. Fokuser på hvad kunden faktisk ville bekymre sig om

Returner KUN valid JSON uden markdown backticks.`,
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
