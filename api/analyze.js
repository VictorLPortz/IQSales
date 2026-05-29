import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ═══════════════════════════════════════════════════════════════
// JSON SANITIZATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function sanitizeJSON(jsonStr) {
  return jsonStr
    .replace(/,(\s*[}\]])/g, '$1')      // Remove trailing commas
    .replace(/
/g, ' ')                 // Remove newlines
    .replace(/
/g, '')                  // Remove carriage returns
    .replace(/	/g, ' ')                 // Replace tabs with spaces
    .replace(/  +/g, ' ')                // Collapse multiple spaces
    .trim();
}

function aggressiveJSONClean(jsonStr) {
  let cleaned = jsonStr;
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
  cleaned = cleaned.replace(
    /"([^"]+)":\s*"([^"]*)"/g,
    function(match, key, value) {
      const escapedValue = value
        .replace(/\"/g, 'TEMP_ESCAPED_QUOTE')
        .replace(/"/g, '\"')
        .replace(/TEMP_ESCAPED_QUOTE/g, '\"');
      return `"${key}": "${escapedValue}"`;
    }
  );
  cleaned = cleaned.replace(/[
