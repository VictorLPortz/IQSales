// ========================================
// pages/admin/pdf-management.js (eller .tsx)
// Admin dashboard til at styre PDF refresh
// ========================================

import { useState, useEffect } from 'react';
import { useSupabaseClient, useUser } from '@supabase/auth-helpers-react';

export default function PdfManagementPage() {
  const supabase = useSupabaseClient();
  const user = useUser();
  
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [stats, setStats] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [insuranceTerms, setInsuranceTerms] = useState([]);
  const [refreshLog, setRefreshLog] = useState([]);
  
  // Load initial data
  useEffect(() => {
    loadStats();
    loadRefreshLog();
  }, []);
  
  async function loadStats() {
    // Get insurance terms count
    const { data: terms } = await supabase
      .from('insurance_terms')
      .select('selskab, produkt_type, parsed_at')
      .order('parsed_at', { ascending: false });
    
    setInsuranceTerms(terms || []);
    
    // Get latest parsing job
    const { data: latestJob } = await supabase
      .from('parsing_log')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(1)
      .single();
    
    setLastRefresh(latestJob);
  }
  
  async function loadRefreshLog() {
    const { data } = await supabase
      .from('parsing_log')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(10);
    
    setRefreshLog(data || []);
  }
  
  async function handleRefresh() {
    if (!confirm('Er du sikker på du vil refreshe alle PDFs? Dette tager ~15 minutter.')) {
      return;
    }
    
    setIsRefreshing(true);
    
    try {
      const { data: { session } } = await supabase.auth.getSession();
      
      const response = await fetch('/api/admin/refresh-pdfs', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });
      
      const result = await response.json();
      
      if (result.success) {
        alert('✅ PDF refresh completed successfully!');
        loadStats();
        loadRefreshLog();
      } else {
        alert(`❌ Error: ${result.error}`);
      }
      
    } catch (error) {
      alert(`❌ Error: ${error.message}`);
    } finally {
      setIsRefreshing(false);
    }
  }
  
  // Format date
  const formatDate = (dateString) => {
    if (!dateString) return 'Never';
    return new Date(dateString).toLocaleString('da-DK');
  };
  
  // Group terms by selskab
  const groupedTerms = insuranceTerms.reduce((acc, term) => {
    if (!acc[term.selskab]) acc[term.selskab] = [];
    acc[term.selskab].push(term);
    return acc;
  }, {});
  
  return (
    <div className="container mx-auto p-8">
      <h1 className="text-3xl font-bold mb-8">PDF Management</h1>
      
      {/* Refresh Button */}
      <div className="bg-white shadow rounded-lg p-6 mb-6">
        <h2 className="text-xl font-semibold mb-4">Manual Refresh</h2>
        
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          className={`px-6 py-3 rounded-lg font-semibold ${
            isRefreshing
              ? 'bg-gray-400 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-700 text-white'
          }`}
        >
          {isRefreshing ? (
            <>
              <span className="inline-block animate-spin mr-2">⏳</span>
              Refreshing... (~15 min)
            </>
          ) : (
            '🔄 Refresh All PDFs Now'
          )}
        </button>
        
        {lastRefresh && (
          <div className="mt-4 text-sm text-gray-600">
            <p>Seneste refresh: {formatDate(lastRefresh.started_at)}</p>
            <p>Status: {lastRefresh.status}</p>
            <p>Success: {lastRefresh.successful_parses}/{lastRefresh.total_pdfs}</p>
            {lastRefresh.total_cost_usd && (
              <p>Cost: ${lastRefresh.total_cost_usd.toFixed(2)}</p>
            )}
          </div>
        )}
      </div>
      
      {/* Current Data Overview */}
      <div className="bg-white shadow rounded-lg p-6 mb-6">
        <h2 className="text-xl font-semibold mb-4">Current Data</h2>
        
        <div className="grid grid-cols-3 gap-4">
          {Object.entries(groupedTerms).map(([selskab, terms]) => (
            <div key={selskab} className="border rounded p-4">
              <h3 className="font-semibold mb-2 capitalize">
                {selskab.replace('_', ' ')}
              </h3>
              <p className="text-2xl font-bold text-blue-600">
                {terms.length} PDFs
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Seneste: {formatDate(terms[0]?.parsed_at)}
              </p>
            </div>
          ))}
        </div>
        
        <div className="mt-4">
          <p className="text-sm text-gray-600">
            Total: <strong>{insuranceTerms.length}</strong> insurance terms loaded
          </p>
        </div>
      </div>
      
      {/* Refresh History */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">Refresh History</h2>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                  Started
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                  Status
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                  Success/Total
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                  Cost
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                  Duration
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {refreshLog.map((job) => {
                const duration = job.completed_at
                  ? Math.round(
                      (new Date(job.completed_at) - new Date(job.started_at)) / 1000
                    )
                  : null;
                
                return (
                  <tr key={job.id}>
                    <td className="px-4 py-2 text-sm">
                      {formatDate(job.started_at)}
                    </td>
                    <td className="px-4 py-2 text-sm">
                      <span
                        className={`px-2 py-1 rounded text-xs ${
                          job.status === 'completed'
                            ? 'bg-green-100 text-green-800'
                            : job.status === 'failed'
                            ? 'bg-red-100 text-red-800'
                            : 'bg-yellow-100 text-yellow-800'
                        }`}
                      >
                        {job.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-sm">
                      {job.successful_parses}/{job.total_pdfs}
                    </td>
                    <td className="px-4 py-2 text-sm">
                      ${job.total_cost_usd?.toFixed(2) || '0.00'}
                    </td>
                    <td className="px-4 py-2 text-sm">
                      {duration ? `${duration}s` : '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
