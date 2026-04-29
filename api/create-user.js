export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify the caller is authenticated and is an admin
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const userToken = authHeader.replace('Bearer ', '');
  const SUPABASE_URL = 'https://pnzpdgjstzuapgknagsa.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBuenBkZ2pzdHp1YXBna25hZ3NhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4ODM1MDUsImV4cCI6MjA5MjQ1OTUwNX0.sZzAvYGS3ks2mn11SAu704Ciq1Ij-s8RnN7paYipnuY';

  // Verify caller is admin
  const profileRes = await fetch(SUPABASE_URL + '/rest/v1/profiles?select=role', {
    headers: {
      'apikey': ANON_KEY,
      'Authorization': 'Bearer ' + userToken
    }
  });
  const profiles = await profileRes.json();
  if (!Array.isArray(profiles) || profiles.length === 0 || profiles[0].role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden — kun admins kan oprette brugere' });
  }

  const { email, password, full_name, department, role } = req.body;
  if (!email || !password || !full_name) {
    return res.status(400).json({ error: 'Email, kodeord og navn er påkrævet' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Kodeord skal være mindst 6 tegn' });
  }

  try {
    // Create user in Supabase Auth using service role key
    const createRes = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name }
      })
    });

    const userData = await createRes.json();
    if (!createRes.ok) {
      return res.status(400).json({ error: userData.message || 'Kunne ikke oprette bruger' });
    }

    // Create profile
    await fetch(SUPABASE_URL + '/rest/v1/profiles', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        id: userData.id,
        email,
        full_name,
        department: department || null,
        role: role || 'seller'
      })
    });

    return res.status(200).json({ success: true, id: userData.id });
  } catch (err) {
    return res.status(500).json({ error: 'Serverfejl: ' + err.message });
  }
}
