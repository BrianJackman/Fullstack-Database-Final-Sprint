const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcrypt');
const User = require('./models/user');
const Poll = require('./models/poll');

const PORT = 3000; // Set your desired port number
const MONGO_URI = 'mongodb://localhost:27017/Voting_app_db'; // Set your MongoDB URI
const SESSION_SECRET = '89dff0917599446f4353702600e336ded32493f1b329cad0bc1a6aa6b62c0627a32819a5f202648dc86da24a6668382be66fc185a8b728ab6ef7317075f4d'; // Set your session secret

const app = express();
const wsInstance = expressWs(app); // Initialize express-ws and get the WebSocket server instance

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
}));

// Middleware to add user to res.locals
app.use((req, res, next) => {
    res.locals.user = req.session.user;
    next();
});

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
    console.log('New WebSocket connection established');

    socket.on('message', async (message) => {
        const data = JSON.parse(message);
        console.log('Received message:', data);
        // Handle incoming messages
    });

    socket.on('close', async (message) => {
        console.log('WebSocket connection closed');
        // Handle socket close
    });
});

app.ws('/vote/:id', (ws, req) => {
    ws.on('message', async (msg) => {
        const { optionIndex } = JSON.parse(msg);
        const poll = await Poll.findById(req.params.id);
        poll.options[optionIndex].votes += 1;
        await poll.save();

        console.log(`Vote received for poll ${req.params.id}, option ${optionIndex}`);

        // Broadcast updated poll to all connected clients
        wsInstance.getWss().clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify(poll));
            }
        });
    });

    ws.on('close', () => {
        console.log(`WebSocket connection closed for poll ${req.params.id}`);
    });
});

// Routes
app.get('/', async (request, response) => {
    const pollCount = await Poll.countDocuments();
    if (request.session.userId) {
        const polls = await Poll.find();
        return response.render('index/authenticatedIndex', { user: request.session.user, polls });
    }

    response.render('index/unauthenticatedIndex', { pollCount });
});

app.get('/login', async (request, response) => {
    response.render('login', { errorMessage: null });
});

app.post('/login', async (request, response) => {
    const { username, password } = request.body;
    const user = await User.findOne({ username });
    if (user && await user.comparePassword(password)) {
        request.session.userId = user._id;
        request.session.user = user; // Set user in session
        response.redirect('/dashboard');
    } else {
        response.render('login', { errorMessage: 'Incorrect username or password' });
    }
});

app.get('/signup', async (request, response) => {
    if (request.session.userId) {
        return response.redirect('/dashboard');
    }

    return response.render('signup', { errorMessage: null });
});

app.post('/signup', async (req, res) => {
    const { username, password } = req.body;
    const existingUser = await User.findOne({ username });
    if (existingUser) {
        return res.render('signup', { errorMessage: 'Username already exists' });
    }
    const user = new User({ username, password });
    await user.save();
    req.session.userId = user._id;
    req.session.user = user; // Set user in session
    res.redirect('/dashboard');
});

app.get('/register', async (request, response) => {
    response.render('register');
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const user = new User({ username, password });
    await user.save();
    req.session.userId = user._id;
    req.session.user = user; // Set user in session
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
    res.render('poll', { poll, errorMessage: null });
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

// Voting on a poll
app.post('/vote/:id', isAuthenticated, async (req, res) => {
    const { pollOption } = req.body;
    const poll = await Poll.findById(req.params.id);
    const user = await User.findById(req.session.userId);

    // Check if the user has already voted on this poll
    if (user.votedPolls.includes(poll._id)) {
        console.log(`User ${user.username} has already voted on poll ${poll._id}`);
        return res.render('poll', { poll, errorMessage: 'You have already voted on this poll' });
    }

    const option = poll.options.find(opt => opt.option === pollOption);
    if (option) {
        option.votes += 1;
        await poll.save();

        // Increment the pollsVoted field for the user and add the poll to votedPolls
        user.pollsVoted += 1;
        user.votedPolls.push(poll._id);
        await user.save();

        console.log(`User ${user.username} voted on poll ${poll._id}`);
        console.log(`Polls Voted In: ${user.pollsVoted}`);
        console.log(`Voted Polls: ${user.votedPolls}`);

        // Broadcast updated poll to all connected clients
        wsInstance.getWss().clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify(poll));
            }
        });
    }
    res.redirect(`/poll/${req.params.id}`);
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
        wsInstance.getWss().clients.forEach(client => {
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
            wsInstance.getWss().clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify(poll));
                }
            });
        }
    } catch (error) {
        console.error('Error updating poll:', error);
    }
}