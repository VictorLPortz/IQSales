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

## 🚫 REGEL 5: UDELAD kun disse specifikke dækninger
Returner IKKE disse dækninger MEDMINDRE der er konkret forskel:

**UDELAD KUN:**
- **Ansvarsforsikring** (lovpligtigt i bilforsikring - alle har 100 mio. kr, dækker automatisk passagerer)

**INKLUDER ALT ANDET** hvor der er forskel mellem selskaberne!

VIGTIGT: Brand, eksplosion, blæsevejr, storm, skybrud, vandskade osv. skal ALTID inkluderes hvis der er forskel!

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

**Eksempel 5: Standard dækning**
A: "Ansvarsforsikring 100 mio. kr"
B: "Ansvarsforsikring 100 mio. kr"
→ winner=equal (lovpligtigt, samme hos alle)

# VIGTIGE PÅMINDELSER
1. Læs HELE betingelserne nøje
2. Brug konkrete beløb fra teksten
3. Vær præcis med vilkår
4. Hvis begge er lige gode, sig det
5. Find ALLE væsentlige dækninger hvor der ER forskel
6. IGNORER kun: Ansvarsforsikring (hvis ens hos begge)
7. INKLUDER ALT ANDET: Blæsevejr, storm, brand, vandskade, tyveri osv.
8. Fokuser på hvad kunden faktisk ville bekymre sig om

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
