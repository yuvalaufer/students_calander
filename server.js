require('dotenv').config();

const express = require('express');
const path = require('path');
const { Octokit } = require("@octokit/rest");
const { google } = require('googleapis');
const basicAuth = require('express-basic-auth');

// --- 1. אתחול השרת ---
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
// פונקציות עזר לחישוב שבועות (מעודכן: Sunday to Sunday)
// ----------------------------------------------------

// פונקציית עזר למציאת תחילת השבוע (יום ראשון)
const getStartOfWeek = (date) => {
    const d = new Date(date);
    const day = d.getDay(); // יום ראשון = 0
    const diff = d.getDate() - day;
    const startOfWeek = new Date(d.setDate(diff));
    startOfWeek.setHours(0, 0, 0, 0);
    return startOfWeek;
};

// פונקציית עזר למציאת סוף השבוע (יום ראשון הבא)
const getEndOfWeek = (date) => {
    const d = new Date(date);
    const day = d.getDay(); // יום ראשון = 0
    // שינוי ל-7 ימים כדי להגיע ליום ראשון הבא (סוף טווח הבדיקה)
    const diff = d.getDate() + (7 - day); 
    const endOfWeek = new Date(d.setDate(diff));
    endOfWeek.setHours(23, 59, 59, 999);
    return endOfWeek;
};


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
        
        // אין שמירה ל-GitHub! רק הדפסה לקונסול כדי להעתיק ל-Render ENV.
        if (tokens.refresh_token) {
            console.log('🚨🚨🚨 REFRESH TOKEN TO SAVE IN RENDER ENV 🚨🚨🚨');
            console.log(tokens.refresh_token);
        }

        res.send(`
            <h1>✅ אימות Google Calendar הצליח!</h1>
            <p>הטוקן
