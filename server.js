require('dotenv').config();

const express = require('express');
const path = require('path');
const { Octokit } = require("@octokit/rest");
const { google } = require('googleapis');
const basicAuth = require('express-basic-auth');

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. הגדרות אבטחה ---
const USERS = {};
USERS[process.env.AUTH_USERNAME] = process.env.AUTH_PASSWORD;

app.use(basicAuth({
    users: USERS,
    challenge: true,
    unauthorizedResponse: 'Unauthorized access. Please login.',
}));

// --- הגדרות GitHub ---
const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO = process.env.GITHUB_REPO_NAME;
const STUDENTS_FILE = 'students.json';
const TOKENS_FILE = 'google_credentials.json';
const PAYMENTS_FILE = 'payments.json'; // קובץ חדש לשמירת סטטוס תשלום

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

async function getFileFromGithub(fileName) {
    try {
        const response = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: fileName });
        const content = Buffer.from(response.data.content, 'base64').toString();
        // נשתמש ב-JSON.parse רק אם הקובץ אינו ריק (במיוחד payments.json בהתחלה)
        const data = content ? JSON.parse(content) : null; 
        return { data: data, sha: response.data.sha };
    } catch (error) {
        if (error.status === 404) {
             return { data: null, sha: null };
        }
        throw new Error(`Failed to fetch ${fileName} from GitHub. Error: ${error.message}`);
    }
}

async function updateFileInGithub(fileName, data, currentSha, commitMessage) {
    // אם לא קיים SHA (כמו בפעם הראשונה של payments.json), זה בסדר
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


// פונקציות טוקן ואימות
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
        console.warn('Could not load Google tokens from GitHub:', e.message);
        return false;
    }
}

async function saveTokens(tokens) {
    const currentTokensFile = await getFileFromGithub(TOKENS_FILE);
    const dataToSave = {
        refresh_token: tokens.refresh_token,
        scope: tokens.scope,
        token_type: tokens.token_type,
        expiry_date: tokens.expiry_date
    };
    if (!dataToSave.refresh_token) {
        throw new Error("Refresh token missing. Cannot save credentials.");
    }
    await updateFileInGithub(TOKENS_FILE, dataToSave, currentTokensFile.sha, "Update: Google API Refresh Token.");
}


// ----------------------------------------------------
// נתיבים (API Routes)
// ----------------------------------------------------

// נתיב אימות Google
app.get('/api/auth/google', (req, res) => {
    const scopes = ['https://www.googleapis.com/auth/calendar.readonly'];
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        prompt: 'consent' 
    });
    res.redirect(url);
});

// נתיב חזרה לאחר אימות
app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.status(400).send('Authentication failed: Missing code.');
    }

    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        await saveTokens(tokens);
        
        res.send(`<h1>✅ אימות Google Calendar הצליח!</h1><p>הטוקן נשמר בקובץ ${TOKENS_FILE} ב-GitHub. המערכת מוכנה לשלוף אירועי יומן.</p><a href="/">חזרה לדף הראשי</a>`);
    } catch (error) {
        console.error('Error during Google OAuth callback:', error);
        res.status(500).send(`Authentication failed: ${error.message}.`);
    }
});


// GET: שליפת רשימת התלמידים (כולל המחיר החדש)
app.get('/api/students', async (req, res) => {
    try {
        const result = await getFileFromGithub(STUDENTS_FILE);
        // 💡 הוספת מחיר ברירת מחדל של 170
        const students = (result.data || []).map(s => ({
            ...s,
            price: s.price || 170 // מחיר דיפולט
        }));
        res.json(students);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST: שמירת רשימת התלמידים החדשה (מעדכן מחיר)
app.post('/api/students/save', async (req, res) => {
    const newStudents = req.body.students; 
    if (!newStudents || !Array.isArray(newStudents)) {
        return res.status(400).json({ error: "Invalid data format." });
    }

    try {
        const currentFile = await getFileFromGithub(STUDENTS_FILE);
        const updatedFile = await updateFileInGithub(STUDENTS_FILE, newStudents, currentFile.sha, "Update: Student list saved via Web UI (including prices).");
        
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

// GET: שליפת אירועים מהיומן (שבועיים קדימה) + נתוני תשלום
app.get('/api/calendar/events', async (req, res) => {
    try {
        await loadTokens(); 

        if (!oauth2Client.credentials || !oauth2Client.credentials.refresh_token) {
            return res.status(401).json({ error: "Google not authenticated. Please navigate to /api/auth/google to connect." });
        }

        const today = new Date();
        const twoWeeksAhead = new Date(today.getTime() + (14 * 24 * 60 * 60 * 1000));

        // 1. שליפת אירועי יומן
        const response = await calendar.events.list({
            calendarId: 'primary', 
            timeMin: today.toISOString(),
            timeMax: twoWeeksAhead.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });
        const events = response.data.items || [];
        
        // 2. שליפת סטטוס תשלום קיים
        const paymentsResult = await getFileFromGithub(PAYMENTS_FILE);
        const payments = paymentsResult.data || {};

        // 3. הוספת סטטוס התשלום לכל אירוע (על ידי event.id)
        const eventsWithPayment = events.map(event => ({
            ...event,
            paymentStatus: payments[event.id] ? payments[event.id].status : 'לא בוצע עדיין', // ברירת מחדל
            lessonKey: event.id // מפתח ייחודי לשיעור
        }));

        res.json(eventsWithPayment);
    } catch (error) {
        console.error("Error fetching calendar events:", error.message);
        res.status(500).json({ error: `Failed to fetch calendar events. Error: ${error.message}` });
    }
});

// POST: שמירת סטטוס תשלום (ל-GitHub)
app.post('/api/payments/save', async (req, res) => {
    const { lessonKey, status } = req.body;
    if (!lessonKey || !status) {
        return res.status(400).json({ error: "Missing lessonKey or status." });
    }

    try {
        const currentFile = await getFileFromGithub(PAYMENTS_FILE);
        const currentPayments = currentFile.data || {};
        
        // עדכון הסטטוס הספציפי
        currentPayments[lessonKey] = { status: status, updated: new Date().toISOString() };
        
        const updatedFile = await updateFileInGithub(PAYMENTS_FILE, currentPayments, currentFile.sha, `Update: Payment status for lesson ${lessonKey}.`);
        
        res.json({ 
            success: true, 
            message: "Payment status saved successfully!",
            commit_url: updatedFile.commit.html_url
        });
        
    } catch (error) {
        console.error("Error in save payments route:", error);
        res.status(500).json({ error: "Failed to save payment data to GitHub." });
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
