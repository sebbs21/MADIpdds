// api/index.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// In-memory session storage (resets on serverless redeploy; use Vercel KV for persistence)
const sessions = {};

// Helper Functions
function generateSessionCode() {
    return uuidv4().substring(0, 6).toUpperCase();
}

function calculatePersonaScore(answers) {
    if (!answers || answers.impactScore === null || answers.importanceScore === null || !answers.selectedPersonas) {
        return 0;
    }
    const personaCountScore = Math.min(answers.selectedPersonas.length, 4);
    return personaCountScore + answers.impactScore + answers.importanceScore;
}

function calculateFinalScore(personaScore, bizImpact, techFeas, differentiation, scalability) {
    const personaWeight = 30;
    const bizImpactWeight = 25;
    const techFeasWeight = 20;
    const differentiationWeight = 15;
    const scalabilityWeight = 10;

    const personaWeighted = (personaScore / 10) * personaWeight;
    const bizWeighted = (bizImpact / 10) * bizImpactWeight;
    const techWeighted = (techFeas / 10) * techFeasWeight;
    const diffWeighted = (differentiation / 10) * differentiationWeight;
    const scaleWeighted = (scalability / 10) * scalabilityWeight;

    return Math.round(personaWeighted + bizWeighted + techWeighted + diffWeighted + scaleWeighted);
}

function getDecision(score) {
    if (score >= 80) return { text: "🔥 Move to Development", class: "develop" };
    if (score >= 60) return { text: "💡 Run an A/B Test First", class: "test" };
    return { text: "❌ Rework or Discard", class: "discard" };
}

// API Endpoints
app.post('/create_session', (req, res) => {
    const sessionId = generateSessionCode();
    while (sessions[sessionId]) {
        sessionId = generateSessionCode();
    }

    sessions[sessionId] = {
        sessionId,
        pm: { joined: true, answers: null },
        researcher: { joined: false, answers: null },
        status: 'waiting_partner'
    };

    console.log(`Session ${sessionId} created`);
    res.json({ sessionId });
});

app.post('/join_session', (req, res) => {
    const { sessionId } = req.body;
    const session = sessions[sessionId];

    if (!session) {
        console.log(`Session ${sessionId} not found`);
        return res.status(404).json({ error: 'Session not found' });
    }

    if (session.researcher.joined) {
        console.log(`Researcher role already taken in session ${sessionId}`);
        return res.status(400).json({ error: 'Researcher role already taken' });
    }

    session.researcher.joined = true;
    session.status = 'active';
    console.log(`Researcher joined session ${sessionId}`);

    res.json({ sessionId, role: 'researcher' });
});

app.post('/submit_answers', (req, res) => {
    const { sessionId, role, answers } = req.body;
    const session = sessions[sessionId];

    if (!session) {
        console.log(`Session ${sessionId} not found`);
        return res.status(404).json({ error: 'Session not found' });
    }

    if ((role === 'pm' && !session.pm.joined) || (role === 'researcher' && !session.researcher.joined)) {
        console.log(`Invalid role ${role} for session ${sessionId}`);
        return res.status(403).json({ error: 'Role not authorized' });
    }

    answers.personaScore = calculatePersonaScore(answers);
    if (role === 'pm') {
        session.pm.answers = answers;
        console.log(`PM answers submitted for session ${sessionId}`);
    } else if (role === 'researcher') {
        session.researcher.answers = answers;
        console.log(`Researcher answers submitted for session ${sessionId}`);
    } else {
        console.log(`Invalid role ${role} for session ${sessionId}`);
        return res.status(400).json({ error: 'Invalid role' });
    }

    if (session.pm.answers && session.researcher.answers) {
        const pmFinalScore = calculateFinalScore(
            session.pm.answers.personaScore,
            session.pm.answers.bizImpact,
            session.pm.answers.techFeas,
            session.pm.answers.differentiation,
            session.pm.answers.scalability
        );
        const researcherFinalScore = calculateFinalScore(
            session.researcher.answers.personaScore,
            session.researcher.answers.bizImpact,
            session.researcher.answers.techFeas,
            session.researcher.answers.differentiation,
            session.researcher.answers.scalability
        );

        const combinedFinalScore = Math.round((pmFinalScore + researcherFinalScore) / 2);
        const decision = getDecision(combinedFinalScore);

        const results = {
            finalScore: combinedFinalScore,
            decision,
            pmAnswers: session.pm.answers,
            researcherAnswers: session.researcher.answers
        };

        session.status = 'complete';
        console.log(`Results calculated for session ${sessionId}: ${combinedFinalScore}`);
        return res.json({ results });
    }

    res.json({ status: 'waiting_for_partner' });
});

app.get('/check_session', (req, res) => {
    const { sessionId, role } = req.query;
    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'active' && role === 'pm' && session.researcher.joined) {
        return res.json({ status: 'active' });
    } else if (session.status === 'complete' && session.pm.answers && session.researcher.answers) {
        const pmFinalScore = calculateFinalScore(
            session.pm.answers.personaScore,
            session.pm.answers.bizImpact,
            session.pm.answers.techFeas,
            session.pm.answers.differentiation,
            session.pm.answers.scalability
        );
        const researcherFinalScore = calculateFinalScore(
            session.researcher.answers.personaScore,
            session.researcher.answers.bizImpact,
            session.researcher.answers.techFeas,
            session.researcher.answers.differentiation,
            session.researcher.answers.scalability
        );

        const combinedFinalScore = Math.round((pmFinalScore + researcherFinalScore) / 2);
        const decision = getDecision(combinedFinalScore);

        const results = {
            finalScore: combinedFinalScore,
            decision,
            pmAnswers: session.pm.answers,
            researcherAnswers: session.researcher.answers
        };
        return res.json({ status: 'complete', results });
    }

    res.json({ status: session.status });
});

app.get('/', (req, res) => {
    res.send('PDDS Backend is running');
});

module.exports = app;