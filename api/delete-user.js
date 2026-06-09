const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify caller is an admin
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Ikke autoriseret' });

  const token = authHeader.replace('Bearer ', '');
  try {
    const verifyResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` }
    });
    if (!verifyResponse.ok) return res.status(401).json({ error: 'Ugyldig session' });

    const userData = await verifyResponse.json();
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userData.id}&select=role`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const profiles = await profileRes.json();
    if (!profiles?.[0] || profiles[0].role !== 'admin') {
      return res.status(403).json({ error: 'Kun admins kan slette brugere' });
    }
  } catch (e) {
    return res.status(401).json({ error: 'Auth fejl' });
  }

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId påkrævet' });

  try {
    // Delete from auth.users via Admin API (also cascades to profiles if FK set)
    const deleteRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });

    if (!deleteRes.ok) {
      const err = await deleteRes.json();
      // If not found in auth, still try to clean up profiles
      if (deleteRes.status !== 404) {
        return res.status(400).json({ error: err.msg || err.message || 'Sletning fejlede' });
      }
    }

    // Also delete from profiles (in case FK cascade isn't set)
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Delete user failed:', error);
    return res.status(500).json({ error: error.message || 'Sletning fejlede' });
  }
};
