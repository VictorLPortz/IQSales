const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify caller is an admin
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Ikke autoriseret' });
  }

  const token = authHeader.replace('Bearer ', '');
  try {
    const verifyResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` }
    });
    if (!verifyResponse.ok) return res.status(401).json({ error: 'Ugyldig session' });

    const userData = await verifyResponse.json();

    // Check admin role
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userData.id}&select=role`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const profiles = await profileRes.json();
    if (!profiles?.[0] || profiles[0].role !== 'admin') {
      return res.status(403).json({ error: 'Kun admins kan oprette brugere' });
    }
  } catch (e) {
    return res.status(401).json({ error: 'Auth fejl' });
  }

  const { email, name, department } = req.body;
  if (!email || !name) {
    return res.status(400).json({ error: 'Email og navn er påkrævet' });
  }

  try {
    // Create user via Admin API — bypasses email confirmation
    const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        email_confirm: true,
        user_metadata: { full_name: name },
        // Send invite email so user can set their own password
        invite: true
      })
    });

    const createData = await createRes.json();

    if (!createRes.ok) {
      const msg = createData.msg || createData.message || JSON.stringify(createData);
      return res.status(400).json({ error: msg });
    }

    const userId = createData.id;

    // Insert profile
    await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        id: userId,
        email,
        full_name: name,
        department: department || null,
        role: 'seller'
      })
    });

    return res.status(200).json({ success: true, userId });

  } catch (error) {
    console.error('Create user failed:', error);
    return res.status(500).json({ error: error.message || 'Oprettelse fejlede' });
  }
};
