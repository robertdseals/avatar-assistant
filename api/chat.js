export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Handle OPTIONS request for CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Call Gemini API
    const response = await fetch(
      https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-8b:generateContent?key=${process.env.AVITAR_KEY},
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: message
            }]
          }]
        })
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('Gemini API error:', error);
      return res.status(response.status).json({ error: `Gemini API error: ${error}` });
    }

    const data = await response.json();
    console.log('Gemini API response:', JSON.stringify(data));
    
    // Extract the response text
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
      console.error('Unexpected response structure:', data);
      return res.status(500).json({ error: 'Unexpected response format from Gemini API' });
    }
    
    const assistantMessage = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response';
    
    return res.status(200).json({ message: assistantMessage });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}   
