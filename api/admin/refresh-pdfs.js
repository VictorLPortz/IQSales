// ========================================
// pages/api/admin/refresh-pdfs.js
// Manual trigger endpoint - kræver admin login
// ========================================

import { runWeeklyPdfRefresh } from '../../lib/pdf-auto-fetch';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Auth check - kun admin kan køre dette
    const { authorization } = req.headers;
    const token = authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    // Verify user er admin via Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Check if user is admin (tilføj admin check her)
    // F.eks. check user email eller rolle
    const adminEmails = process.env.ADMIN_EMAILS?.split(',') || [];
    if (!adminEmails.includes(user.email)) {
      return res.status(403).json({ error: 'Forbidden - Admin only' });
    }
    
    console.log(`🚀 PDF refresh triggered by admin: ${user.email}`);
    
    // Kør PDF refresh
    const result = await runWeeklyPdfRefresh();
    
    return res.status(200).json({
      success: true,
      message: 'PDF refresh completed successfully',
      stats: result
    });
    
  } catch (error) {
    console.error('❌ PDF refresh failed:', error);
    
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

// Disable timeout for long-running requests
export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
  maxDuration: 300, // 5 minutes timeout
};
