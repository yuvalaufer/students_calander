require('dotenv').config();

const express = require('express');
const path = require('path');
const { Octokit } = require("@octokit/rest");
const { google } = require('googleapis');
const basicAuth = require('express-basic-auth');

// --- 1. אתחול השרת (חובה שיהיה ראשון) ---
const app = express();
const PORT = process.env.PORT || 3000;

// --- 2. הגדרות אבטחה ו-Middleware ---
const USERS = {};
USERS[process.env.AUTH_USERNAME] = process.env.AUTH_PASSWORD;

app.use(basicAuth({
    users: USERS,
    challenge: true,
    unauthorizedResponse: 'Unauthorized access. Please login.',
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


// --- 3. הגדרות GitHub ו-Google ---
const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO = process.env.GITHUB_REPO_NAME;
const STUDENTS_FILE = 'students.json';
const PAYMENTS_FILE = 'payments.json';

// אתחול Octokit
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


// ----------------------------------------------------
// פונקציות עזר ל-GitHub (שמירת נתונים)
// ----------------------------------------------------

async function getFileFromGithub(fileName) {
    try {
        const response = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: fileName });
        const content = Buffer.from(response.data.content, 'base64').toString();
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

// טעינת טוקן - טוענים ממשתנה סביבה!
async function loadTokens() {
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    if (refreshToken) {
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        console.log('✅ Google Refresh Token loaded from Render environment successfully.');
        return true;
    }
    console.log('⚠️ Google Refresh Token not found in environment. Must authenticate.');
    return false;
}

// ----------------------------------------------------
// נתיבים (API Routes)
// ----------------------------------------------------

app.get('/api/auth/google', (req, res) => {
    const scopes = ['https://www.googleapis.com/auth/calendar.readonly'];
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        prompt: 'consent' 
    });
    res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.status(400).send('Authentication failed: Missing code.');
    }

    try {
        const { tokens } = await oauth2Client.getToken(code);
        
        oauth2Client.setCredentials(tokens);
        
        // 🛑 אין שמירה ל-GitHub! רק הדפסה לקונסול כדי להעתיק ל-Render ENV.
        if (tokens.refresh_token) {
            console.log('🚨🚨�� REFRESH TOKEN TO SAVE IN RENDER ENV 🚨🚨🚨');
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


// ... (נתיבים ל-students) ...
app.get('/api/students', async (req, res) => {
    try {
        const result = await getFileFromGithub(STUDENTS_FILE);
        const students = (result.data || []).map(s => ({
            ...s,
            price: s.price || 170 
        }));
        res.json(students);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

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


// ... (נתיבים ל-calendar ו-payments) ...
app.get('/api/calendar/events', async (req, res) => {
    try {
        await loadTokens(); 

        if (!oauth2Client.credentials || !oauth2Client.credentials.refresh_token) {
            return res.status(401).json({ error: "Google not authenticated. Please navigate to /api/auth/google to connect." });
        }

        const today = new Date();
        const twoWeeksAhead = new Date(today.getTime() + (14 * 24 * 60 * 60 * 1000));

        const response = await calendar.events.list({
            calendarId: 'primary', 
            timeMin: today.toISOString(),
            timeMax: twoWeeksAhead.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });
        const events = response.data.items || [];
        
        const paymentsResult = await getFileFromGithub(PAYMENTS_FILE);
        const payments = paymentsResult.data || {};

        const eventsWithPayment = events.map(event => ({
            ...event,
            paymentStatus: payments[event.id] ? payments[event.id].status : 'לא בוצע עדיין',
            lessonKey: event.id
        }));

        res.json(eventsWithPayment);
    } catch (error) {
        console.error("Error fetching calendar events:", error.message);
        res.status(500).json({ error: `Failed to fetch calendar events. Error: ${error.message}` });
    }
});

app.post('/api/payments/save', async (req, res) => {
    const { lessonKey, status } = req.body;
    if (!lessonKey || !status) {
        return res.status(400).json({ error: "Missing lessonKey or status." });
    }

    try {
        const currentFile = await getFileFromGithub(PAYMENTS_FILE);
        const currentPayments = currentFile.data || {};
        
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

loadTokens().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
});
