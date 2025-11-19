// שים לב: זה רק חלק מקובץ server.js!

// ----------------------------------------------------
// פונקציות אימות וטוקן ל-Google
// ----------------------------------------------------

// שמירת טוקן חדש - מדפיסים לקונסול בלבד!
async function saveTokens(tokens) {
    // 💡 שימו לב: הפסקנו לשמור ב-GitHub! רק מדפיסים למשתמש כדי שיעתיק ל-Render.
    if (tokens.refresh_token) {
        console.log('🚨🚨🚨 NEW REFRESH TOKEN GENERATED 🚨🚨🚨');
        console.log('COPY THIS TOKEN AND PASTE IT AS GOOGLE_REFRESH_TOKEN IN RENDER ENVIRONMENT:');
        console.log(tokens.refresh_token);
        console.log('🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨');
    }
    // החזרת הצלחה מבלי לגעת ב-GitHub
    return;
}

// נתיב חזרה לאחר אימות
app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.status(400).send('Authentication failed: Missing code.');
    }

    try {
        const { tokens } = await oauth2Client.getToken(code);
        
        oauth2Client.setCredentials(tokens);
        
        // *הסרנו את הקריאה ל-await saveTokens(tokens) כי היא עדיין נתקעת!*
        // נדפיס את הטוקן ידנית כאן כדי לקבל אותו בוודאות.

        if (tokens.refresh_token) {
            console.log('🚨🚨🚨 REFRESH TOKEN TO SAVE IN RENDER ENV 🚨🚨🚨');
            console.log(tokens.refresh_token);
        }

        res.send(`
            <h1>✅ אימות Google Calendar הצליח!</h1>
            <p>הטוקן הודפס ללוגים. **אנא העתק את הטוקן המלא מהלוגים** ושמור אותו כמשתנה סביבה **GOOGLE_REFRESH_TOKEN** ב-Render.</p>
            <p>לאחר השמירה ב-Render, לחץ על **'טען אירועי יומן'** בדף הראשי.</p>
            <a href="/">חזרה לדף הראשי</a>
        `);
    } catch (error) {
        console.error('Error during Google OAuth callback:', error);
        res.status(500).send(`Authentication failed: ${error.message}.`);
    }
});
