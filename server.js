require('dotenv').config();

const express = require('express');
const path = require('path');
const { Octokit } = require("@octokit/rest");
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// הגדרות GitHub
const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO = process.env.GITHUB_REPO_NAME;
const STUDENTS_FILE = 'students.json';
const TOKENS_FILE = 'tokens.json'; // קובץ לשמירת טוקן Google Refresh Token

// אתחול Octokit לגישה ל-GitHub API
const octokit = new Octokit({
    auth: process.env.GITHUB_ACCESS_TOKEN
});

// הגדרות Google OAuth2
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

// ה-Calendar API
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

app.use(express.json());

// 💡 זה הנתיב שמגיש את index.html ואת שאר הקבצים מתיקיית public
app.use(express.static(path.join(__dirname, 'public')));


// ----------------------------------------------------
// פונקציות עזר ל-GitHub (שמירת נתונים)
// ----------------------------------------------------

// פונקציה כללית לשליפת קובץ מ-GitHub
async function getFileFromGithub(fileName) {
    try {
        const response = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: fileName });
        const content = Buffer.from(response.data.content, 'base64').toString();
        const data = JSON.parse(content);
        return { data: data, sha: response.data.sha };
    } catch (error) {
        // אם הקובץ לא נמצא, נחזיר null
        if (error.status === 404) {
             return { data: null, sha: null };
        }
        throw new Error(`Failed to fetch ${fileName} from GitHub.`);
    }
}

// פונקציה כללית לעדכון קובץ ב-GitHub
async function updateFileInGithub(fileName, data, currentSha, commitMessage) {
    // SHA נדרש לעדכון, אם הקובץ לא קיים, לא נבצע עדכון.
    if (fileName !== TOKENS_FILE && !currentSha) {
         throw new Error("SHA is required to update existing file.");
    }
    
    // בגלל ש-tokens.json נוצר בפעם הראשונה, ה-SHA שלו יכול להיות null, וזה בסדר.
    const content = Buffer.from(JSON.stringify(data, null, 4)).toString('base64');
    
    const response = await octokit.repos.createOrUpdateFileContents({
        owner: OWNER,
        repo: REPO,
        path: fileName,
        message: commitMessage,
        content: content,
        sha: currentSha,
        committer: { name: 'Tutor Calendar Bot', email: 'bot@example.com' },
    });
    return response.data;
}


// ----------------------------------------------------
// פונקציות אימות וטוקן ל-Google
// ----------------------------------------------------

// טעינת טוקן (אם קיים)
async function loadTokens() {
    try {
        const fileResult = await getFileFromGithub(TOKENS_FILE);
        if (fileResult.data && fileResult.data.refresh_token) {
            oauth2Client.setCredentials(fileResult.data);
            console.log('✅ Google Refresh Token loaded successfully.');
            return true;
        }
        return false;
    } catch (e) {
        // שגיאות כאן לא צריכות להפיל את השרת, רק לתעדף אותן
        console.warn('Could not load Google tokens from GitHub:', e.message);
        return false;
    }
}

// שמירת טוקן חדש (לאחר אימות ראשוני)
async function saveTokens(tokens) {
    // 1. קוראים את הקובץ הנוכחי כדי לקבל את ה-SHA שלו
    const currentTokensFile = await getFileFromGithub(TOKENS_FILE);
    
    // 2. מוודאים ששומרים את refresh_token
    const dataToSave = {
        refresh_token: tokens.refresh_token,
        scope: tokens.scope,
        token_type: tokens.token_type,
        expiry_date: tokens.expiry_date
    };
    
    if (!dataToSave.refresh_token) {
        throw new Error("Refresh token missing. Cannot save credentials.");
    }
    
    // 3. מעדכנים את הקובץ ב-GitHub
    await updateFileInGithub(TOKENS_FILE, dataToSave, currentTokensFile.sha, "Update: Google API Refresh Token.");
}


// ----------------------------------------------------
// נתיבים (API Routes)
// ----------------------------------------------------

// 1. נתיב התחברות ל-Google (יוזם את האימות)
app.get('/api/auth/google', (req, res) => {
    const scopes = ['https://www.googleapis.com/auth/calendar.readonly'];
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline', // חובה לקבלת Refresh Token קבוע
        scope: scopes,
        prompt: 'consent' 
    });
    res.redirect(url);
});

// 2. נתיב חזרה לאחר אימות (Redirect URI)
app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.status(400).send('Authentication failed: Missing code.');
    }

    try {
        const { tokens } = await oauth2Client.getToken(code);
        
        // מעדכנים את האובייקט המקומי ואת הקובץ ב-GitHub
        oauth2Client.setCredentials(tokens);
        await saveTokens(tokens);
        
        res.send('<h1>✅ אימות Google Calendar הצליח!</h1><p>הטוקן נשמר בקובץ tokens.json ב-GitHub. המערכת מוכנה לשלוף אירועי יומן.</p><a href="/">חזרה לדף הראשי</a>');
    } catch (error) {
        console.error('Error during Google OAuth callback:', error);
        res.status(500).send(`Authentication failed: ${error.message}.`);
    }
});


// 3. GET: שליפת רשימת התלמידים (מ-GitHub)
app.get('/api/students', async (req, res) => {
    try {
        const result = await getFileFromGithub(STUDENTS_FILE);
        res.json(result.data || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. POST: שמירת רשימת התלמידים החדשה (ל-GitHub)
app.post('/api/students/save', async (req, res) => {
    const newStudents = req.body.students; 
    if (!newStudents || !Array.isArray(newStudents)) {
        return res.status(400).json({ error: "Invalid data format." });
    }

    try {
        const currentFile = await getFileFromGithub(STUDENTS_FILE);
        const updatedFile = await updateFileInGithub(STUDENTS_FILE, newStudents, currentFile.sha, "Update: Student list saved via Web UI.");
        
        res.json({ 
            success: true, 
            message: "Student list updated and pushed to GitHub successfully!",
            commit_url: updatedFile.commit.html_url
        });
        
    } catch (error) {
        console.error("Error in save students route:", error);
        res.status(500).json({ error: "Failed to save data to GitHub. Check PAT permissions." });
    }
});


// 5. GET: שליפת אירועים מהיומן (שבועיים קדימה)
app.get('/api/calendar/events', async (req, res) => {
    try {
        // לוודא שה-Refresh Token נטען
        await loadTokens(); 

        if (!oauth2Client.credentials || !oauth2Client.credentials.refresh_token) {
            return res.status(401).json({ error: "Google not authenticated. Please navigate to /api/auth/google to connect." });
        }

        const today = new Date();
        const twoWeeksAhead = new Date(today.getTime() + (14 * 24 * 60 * 60 * 1000)); // שבועיים קדימה

        const response = await calendar.events.list({
            calendarId: 'primary', 
            timeMin: today.toISOString(),
            timeMax: twoWeeksAhead.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });

        res.json(response.data.items);
    } catch (error) {
        console.error("Error fetching calendar events:", error.message);
        res.status(500).json({ error: `Failed to fetch calendar events. Error: ${error.message}` });
    }
});

// ----------------------------------------------------
// הרצת השרת
// ----------------------------------------------------

// טוענים טוקן ושומרים אותו בזיכרון לפני הפעלת השרת
loadTokens().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
});
