// api/index.js - Backend for PDDS Collaborative Score Card (Vercel Serverless)
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { v4: uuidv4 } = require('uuid'); // For generating unique session IDs

const app = express();
const server = http.createServer(app);

// Configure Socket.IO CORS for Vercel deployment and local dev
const io = new Server(server, {
    cors: {
        origin: [
            //"http://localhost:5500", // Allow local dev (update port if needed)
            //"http://127.0.0.1:5500", 
            "https://mad-ipdds.vercel.app/",// Allow local dev
            // Add your Vercel deployment URL(s) here AFTER deploying the frontend
            // e.g., "https://your-vercel-project-name.vercel.app"
            // You might need to configure Vercel environment variables for this
        ],
        methods: ["GET", "POST"]
    }
});

// In-memory storage for active sessions.
// NOTE: This will reset on server restart/redeployment in a serverless environment.
// For persistence, use Vercel KV, Redis, or a database.
const sessions = {};

// --- Helper Functions ---

function generateSessionCode() {
    // Simple 6-char uppercase alphanumeric code
    return uuidv4().substring(0, 6).toUpperCase();
}

function calculatePersonaScore(answers) {
    if (!answers || answers.impactScore === null || answers.importanceScore === null || !answers.selectedPersonas) {
        return 0; // Or handle error appropriately
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


// --- Socket.IO Event Handling ---

io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.on('create_session', () => {
        try {
            const sessionId = generateSessionCode();
            // Ensure code is unique (highly unlikely collision, but good practice)
            while (sessions[sessionId]) {
                sessionId = generateSessionCode();
            }

            sessions[sessionId] = {
                sessionId: sessionId,
                pm: { socketId: socket.id, joined: true, answers: null },
                researcher: { socketId: null, joined: false, answers: null },
                status: 'waiting_partner' // Waiting for researcher
            };

            socket.join(sessionId); // Join the room for this session
            console.log(`Session ${sessionId} created by PM ${socket.id}`);
            socket.emit('session_created', sessionId);
        } catch (error) {
            console.error("Error creating session:", error);
            socket.emit('error_message', 'Failed to create session. Please try again.');
        }
    });

    socket.on('join_session', (sessionId) => {
        try {
            const session = sessions[sessionId];
            if (!session) {
                socket.emit('error_message', `Sesión no encontrada: ${sessionId}`);
                console.log(`Join attempt failed: Session ${sessionId} not found.`);
                return;
            }

            if (session.researcher.joined) {
                // Allow rejoining if the socket ID matches (e.g., after refresh)
                if (session.researcher.socketId === socket.id) {
                     socket.join(sessionId);
                     console.log(`Researcher ${socket.id} rejoined session ${sessionId}`);
                     socket.emit('session_joined', sessionId, 'researcher'); // Confirm rejoin
                     // Maybe resend current state if needed
                } else {
                    socket.emit('error_message', 'El rol de Researcher ya está ocupado en esta sesión.');
                    console.log(`Join attempt failed: Researcher role full in session ${sessionId}`);
                }
                return;
            }

             if (session.pm.socketId === socket.id) {
                 // PM trying to join as researcher? Prevent this.
                  socket.emit('error_message', 'Ya estás en esta sesión como PM.');
                  console.log(`Join attempt failed: PM ${socket.id} tried to join session ${sessionId} as Researcher.`);
                  return;
             }


            // Assign Researcher role
            session.researcher.socketId = socket.id;
            session.researcher.joined = true;
            session.status = 'active'; // Both participants are in

            socket.join(sessionId); // Researcher joins the room
            console.log(`Researcher ${socket.id} joined session ${sessionId}`);

            // Notify Researcher they joined successfully
            socket.emit('session_joined', sessionId, 'researcher');

            // Notify PM that the partner has joined
            if (session.pm.socketId) {
                io.to(session.pm.socketId).emit('partner_joined');
            } else {
                 console.warn(`Session ${sessionId}: PM socket ID missing when researcher joined.`);
                 // Maybe PM disconnected? Handle this case if needed.
            }

        } catch (error) {
            console.error(`Error joining session ${sessionId}:`, error);
            socket.emit('error_message', 'Failed to join session. Please check the code or try again.');
        }
    });

    socket.on('submit_answers', ({ sessionId, role, answers }) => {
         try {
            const session = sessions[sessionId];
            if (!session) {
                socket.emit('error_message', 'Sesión inválida o expirada.');
                console.log(`Submit failed: Session ${sessionId} not found.`);
                return;
            }

            // Validate role and ensure user is part of the session
            if ((role === 'pm' && session.pm.socketId !== socket.id) ||
                (role === 'researcher' && session.researcher.socketId !== socket.id)) {
                socket.emit('error_message', 'Error de autenticación de rol.');
                console.log(`Submit failed: Role mismatch for socket ${socket.id} in session ${sessionId}`);
                return;
            }

            // Calculate persona score before storing
            answers.personaScore = calculatePersonaScore(answers);

            // Store answers
            if (role === 'pm') {
                session.pm.answers = answers;
                console.log(`PM answers received for session ${sessionId}`);
            } else if (role === 'researcher') {
                session.researcher.answers = answers;
                 console.log(`Researcher answers received for session ${sessionId}`);
            } else {
                 console.warn(`Invalid role ${role} submitting answers for session ${sessionId}`);
                 return; // Invalid role
            }

            // Check if both have submitted
            if (session.pm.answers && session.researcher.answers) {
                console.log(`Both answers received for session ${sessionId}. Calculating results...`);
                session.status = 'calculating';

                // Calculate combined score (e.g., average the final scores)
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

                // Simple average for combined score
                const combinedFinalScore = Math.round((pmFinalScore + researcherFinalScore) / 2);
                const decision = getDecision(combinedFinalScore);

                const results = {
                    finalScore: combinedFinalScore,
                    decision: decision,
                    pmAnswers: session.pm.answers,
                    researcherAnswers: session.researcher.answers
                };

                session.status = 'complete';
                // Broadcast results to everyone in the session room
                io.to(sessionId).emit('results_ready', results);
                console.log(`Results sent for session ${sessionId}`);

                // Optionally: Clean up the session after a delay
                // setTimeout(() => {
                //     delete sessions[sessionId];
                //     console.log(`Session ${sessionId} cleaned up.`);
                // }, 60000 * 5); // Clean up after 5 minutes

            } else {
                // Only one user submitted, notify them to wait
                socket.emit('waiting_for_partner');
                console.log(`Socket ${socket.id} waiting for partner in session ${sessionId}`);
            }
         } catch (error) {
              console.error(`Error processing answers for session ${sessionId}:`, error);
              socket.emit('error_message', 'Error processing your answers. Please try again.');
         }
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        // Find which session(s) the disconnected user was in and notify partner(s)
        for (const sessionId in sessions) {
            const session = sessions[sessionId];
            let partnerSocketId = null;
            let disconnectedRole = null;

            if (session.pm.socketId === socket.id) {
                 // PM disconnected
                 session.pm.joined = false; // Mark as not joined
                 session.pm.socketId = null; // Clear socket id
                 partnerSocketId = session.researcher.socketId;
                 disconnectedRole = 'PM';
                 console.log(`PM ${socket.id} disconnected from session ${sessionId}`);

            } else if (session.researcher.socketId === socket.id) {
                 // Researcher disconnected
                 session.researcher.joined = false;
                 session.researcher.socketId = null;
                 partnerSocketId = session.pm.socketId;
                 disconnectedRole = 'Researcher';
                 console.log(`Researcher ${socket.id} disconnected from session ${sessionId}`);
            }

            if (disconnectedRole && partnerSocketId && session.status !== 'complete') {
                // Notify the remaining partner if the session wasn't finished
                 io.to(partnerSocketId).emit('error_message', `El ${disconnectedRole} se ha desconectado. La sesión ha terminado.`);
                 // Optionally clean up session immediately or mark as aborted
                 session.status = 'aborted';
                 // delete sessions[sessionId]; // Or mark as aborted
            }

             // Basic cleanup: Remove session if both are disconnected or aborted
             if (!session.pm.joined && !session.researcher.joined) {
                  delete sessions[sessionId];
                  console.log(`Session ${sessionId} removed due to both participants disconnecting.`);
             }
        }
    });
});

// Basic HTTP route (optional, good for health checks)
app.get('/api', (req, res) => {
    res.send('PDDS Backend is running');
});

// Start the server only if not in a serverless environment (for local testing)
// Vercel will handle invoking the serverless function.
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    const PORT = process.env.PORT || 3001;
    server.listen(PORT, () => {
        console.log(`Server listening on *:${PORT}`);
    });
}

// Export the app for Vercel's serverless environment
module.exports = app;

// You might need a vercel.json file to configure routing if needed,
// but often Vercel handles API routes automatically if placed in /api.
