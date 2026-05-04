const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { authorization } = req.headers;
    const token = authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Check admin role
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    
    if (!profile || profile.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden - Admin only' });
    }
    
    console.log(`PDF refresh triggered by: ${user.email}`);
    
    // TODO: Implement actual PDF refresh logic here
    
    return res.status(200).json({
      success: true,
      message: 'PDF refresh will be implemented soon'
    });
    
  } catch (error) {
    console.error('Refresh failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
