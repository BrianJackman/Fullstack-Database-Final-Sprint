require('dotenv').config();
const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcrypt');
const User = require('./models/user');
const Poll = require('./models/poll');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/Voting_app_db';
const app = express();
expressWs(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(session({
    secret: '89dff0917599446f4353702600e336de241d32493f1b329cad0bc1a6aa6b62c0627a32819a5f202648dc86da24a6668382be66fc185a8b728ab6ef7317075f4d',
    resave: false,
    saveUninitialized: false,
}));
let connectedClients = [];

// Middleware to check if user is logged in
function isAuthenticated(req, res, next) {
    if (req.session.userId) {
        return next();
    }
    res.redirect('/');
}

// WebSocket for real-time voting
app.ws('/ws', (socket, request) => {
    connectedClients.push(socket);

    socket.on('message', async (message) => {
        const data = JSON.parse(message);
        // Handle incoming messages
    });

    socket.on('close', async (message) => {
        // Handle socket close
    });
});

app.ws('/vote/:id', (ws, req) => {
    ws.on('message', async (msg) => {
        const { optionIndex } = JSON.parse(msg);
        const poll = await Poll.findById(req.params.id);
        poll.options[optionIndex].votes += 1;
        await poll.save();

        // Broadcast updated poll to all connected clients
        expressWs.getWss().clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify(poll));
            }
        });
    });
});

// Routes
app.get('/', async (request, response) => {
    if (request.session.userId) {
        const polls = await Poll.find();
        return response.render('index/authenticatedIndex', { user: request.session.user, polls });
    }

    response.render('index/unauthenticatedIndex');
});

app.get('/login', async (request, response) => {
    response.render('login');
});

app.post('/login', async (request, response) => {
    const { username, password } = request.body;
    const user = await User.findOne({ username });
    if (user && await user.comparePassword(password)) {
        request.session.userId = user._id;
        request.session.user = user;
        response.redirect('/dashboard');
    } else {
        response.redirect('/login');
    }
});

app.get('/signup', async (request, response) => {
    if (request.session.userId) {
        return response.redirect('/dashboard');
    }

    return response.render('signup', { errorMessage: null });
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const user = new User({ username, password });
    await user.save();
    req.session.userId = user._id;
    req.session.user = user;
    res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/dashboard', isAuthenticated, async (request, response) => {
    const polls = await Poll.find();
    return response.render('index/authenticatedIndex', { user: request.session.user, polls });
});

app.get('/poll/:id', isAuthenticated, async (req, res) => {
    const poll = await Poll.findById(req.params.id);
    res.render('poll', { poll });
});

app.post('/poll', isAuthenticated, async (req, res) => {
    const { question, options } = req.body;
    const poll = new Poll({
        question,
        options: options.map(option => ({ option })),
        createdBy: req.session.userId
    });
    await poll.save();
    res.redirect('/dashboard');
});

app.get('/profile', isAuthenticated, async (request, response) => {
    const user = await User.findById(request.session.userId);
    response.render('profile', { user });
});

// Route to render the createPoll.ejs file
app.get('/createPoll', isAuthenticated, (req, res) => {
    res.render('createPoll');
});

// Poll creation
app.post('/createPoll', isAuthenticated, async (request, response) => {
    const { question, options } = request.body;
    const formattedOptions = options.split(',').map(option => ({ option: option.trim(), votes: 0 }));

    const pollCreationError = await onCreateNewPoll(question, formattedOptions);
    if (pollCreationError) {
        // Handle error
    } else {
        response.redirect('/dashboard');
    }
});

mongoose.connect(MONGO_URI)
    .then(() => app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`)))
    .catch((err) => console.error('MongoDB connection error:', err));

/**
 * Handles creating a new poll, based on the data provided to the server
 * 
 * @param {string} question The question the poll is asking
 * @param {[answer: string, votes: number]} pollOptions The various answers the poll allows and how many votes each answer should start with
 * @returns {string?} An error message if an error occurs, or null if no error occurs.
 */
async function onCreateNewPoll(question, pollOptions) {
    try {
        const poll = new Poll({ question, options: pollOptions });
        await poll.save();

        // Tell all connected sockets that a new poll was added
        connectedClients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify(poll));
            }
        });
    } catch (error) {
        console.error(error);
        return "Error creating the poll, please try again";
    }

    return null;
}

/**
 * Handles processing a new vote on a poll
 * 
 * @param {string} pollId The ID of the poll that was voted on
 * @param {string} selectedOption Which option the user voted for
 */
async function onNewVote(pollId, selectedOption) {
    try {
        const poll = await Poll.findById(pollId);
        const option = poll.options.find(opt => opt.option === selectedOption);
        if (option) {
            option.votes += 1;
            await poll.save();

            // Broadcast updated poll to all connected clients
            connectedClients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify(poll));
                }
            });
        }
    } catch (error) {
        console.error('Error updating poll:', error);
    }
}