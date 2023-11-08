// Configuration
const config = require('./config.json');
// Dependencies
const express = require('express');
const passport = require('passport');
const session = require('express-session');
const DiscordStrategy = require('passport-discord').Strategy;
const SteamStrategy = require('passport-steam').Strategy;
const bodyParser = require('body-parser');
const path = require('path');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const colors = require('colors');
const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('./database.db');
db.serialize(() => {
	// database schema, 3 columns, discordId, steamID, and userData, discord and steam IDs are unique/primary keys
	db.run("CREATE TABLE IF NOT EXISTS users (discordId TEXT UNIQUE, steamId TEXT UNIQUE, userData TEXT)");
});

const Discord = require("discord.js");
const hook = new Discord.WebhookClient({"url": config.responseWebhook})



// Express app
const app = express();
// Passport session setup
passport.serializeUser(function (user, done) {
	done(null, user);
});

passport.deserializeUser(function (obj, done) {
	done(null, obj);
});

// Discord authentication
passport.use(new DiscordStrategy({
	clientID: config.discord.clientID,
	clientSecret: config.discord.clientSecret,
	callbackURL: `${config.hostname}/auth/discord/callback`,
	scope: ["identify"]
}, function (accessToken, refreshToken, profile, done) {
	process.nextTick(function () {
		return done(null, profile);
	});
}));

// Steam authentication
passport.use(new SteamStrategy({
	returnURL: `${config.hostname}auth/steam/callback`,
	realm: config.hostname,
	apiKey: config.steam.apiKey
}, function (identifier, profile, done) {
	process.nextTick(function () {
		return done(null, profile);
	});
}));

// Express setup
app.use(session({
	secret: config.session.secret,
	resave: false,
	saveUninitialized: false
}));
app.use(cookieParser(config.cookieSecret));
app.use(passport.initialize());
app.use(passport.session());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
// set views directory
app.set('views', path.join(__dirname, 'views'));

var sessionData = {};

// / route, send start.ejs
app.get('/', function (req, res) {
	// Check if useragent is Discordbot
	if (req.headers['user-agent'].includes('Discordbot')) {
		// send some custom html with meta tags
		return res.send(`
			<html>
				<head>
					<meta property="og:title" content="Staff application form!" />
				</head>
			</html>
			`);
	}
	// if they have a valid session token set, send them to the form
	if (req.cookies.session) {
		if (sessionData[req.cookies.session]) {
			if (sessionData[req.cookies.session].discordID && sessionData[req.cookies.session].steamID) {
				return res.redirect('/form');
			}
		}
	}
	// if they don't have a valid session token set, send them to the login page
	res.render('start.ejs');
})

// Routes
app.get('/login', function (req, res) {
	// clear any existing session
	req.session.destroy();
	// Set some sort of session token to tie certain variables to the user
	sessionToken = crypto.randomBytes(32).toString('hex');
	// put session token in cookie
	res.cookie('session', sessionToken, { maxAge: 900000, httpOnly: true });
	// Set the session token in the sessionData object
	sessionData[sessionToken] = {};
	res.redirect('/login/discord');
});

app.get('/login/discord', passport.authenticate('discord'));

app.get('/login/steam', passport.authenticate('steam'));

app.get('/auth/discord/callback', passport.authenticate('discord', {
	failureRedirect: '/login/discord'
}), function (req, res) {
	// if session token is not set, send to /

	if (!req.cookies.session) return res.redirect('/');
	if (!sessionData[req.cookies.session]) return res.redirect('/');
	console.log("After discord auth, session token is set")
	sessionToken = req.cookies.session;
	var discordID = req.session.passport.user.id; // Discord ID from the Discord authentication
	// Put the discord ID in the sessionData object
	sessionData[sessionToken].discordID = discordID;
	sessionData[sessionToken].discordData = req.session.passport.user;
	console.log(sessionData[sessionToken]);
	res.redirect('/login/steam');
});

app.get('/auth/steam/callback', passport.authenticate('steam', {
	failureRedirect: '/login/steam'
}), function (req, res) {
	if (!req.cookies.session) return res.redirect('/');
	if (!sessionData[req.cookies.session]) return res.redirect('/');
	console.log("After steam auth, session token is set")
	sesionToken = req.cookies.session;
	var steamID = req.user._json.steamid; // Steam ID from the Steam authentication
	// Put the steam ID in the sessionData object

	sessionData[sessionToken].steamID = steamID;
	sessionData[sessionToken].steamData = req.user._json;
	console.log(sessionData[sessionToken]);
	res.redirect('/form');
});

// form route, send html file
app.get('/form', function (req, res) {
	if (!req.cookies.session) return res.redirect('/');
	if (!sessionData[req.cookies.session]) return res.redirect('/');
	sessionToken = req.cookies.session;
	// Check if the session token is in the sessionData object
	if (sessionData[sessionToken]) {
		// Check if the discordID and steamID are in the sessionData object
		if (sessionData[sessionToken].discordID && sessionData[sessionToken].steamID) {
			return res.render('form.ejs', {sessionData: sessionData[sessionToken]});
		}
	}
	// Redirect to the home page if the session token is not in the sessionData object
	res.redirect('/');
});

// form post route, sfor now, just print the data to logs, form questions may be changed, so dynamic form creation is needed
app.post('/form', async function (req, res) {
	if (!req.cookies.session) return res.redirect('/');
	if (!sessionData[req.cookies.session]) return res.redirect('/');
	sessionToken = req.cookies.session;
	// Check if the session token is in the sessionData object
	if (sessionData[sessionToken]) {
		// Check if the discordID and steamID are in the sessionData object
		if (sessionData[sessionToken].discordID && sessionData[sessionToken].steamID) {
			sessionData[sessionToken].formData = req.body;
			// put the user in the database, if it fails (discordID or steamID already exists), send them to the failure page (they already filled it out)
			db.run(`INSERT INTO users (discordId, steamId, userData) VALUES (?, ?, ?)`, [sessionData[sessionToken].discordID, sessionData[sessionToken].steamID, JSON.stringify(sessionData[sessionToken])], function (err) {
				if (err) {
					if (err.errno !== 19) { // its not a duplicate error, send logs
						console.log("An error occured while inserting into the database");
						stack = {error: err, sessionData: sessionData[sessionToken]};
						console.log(stack);
					}
					return res.render('failure.ejs', {sessionData: sessionData[sessionToken]})
				}
				// Generate Discord embed JSON for the staff channel, a feild for each question, discord and steam name and ids in description
				embed = {
					"title": "New Staff Application",
					"description": `Discord: <@${sessionData[sessionToken].discordID}> (${sessionData[sessionToken].discordID})\nSteam: ${sessionData[sessionToken].steamData.personaname} (${sessionData[sessionToken].steamID})`,
					"color": 0x00ff00,
					"fields": []
				}
				// Add a field for each question
				for (var key in sessionData[sessionToken].formData) {
					embed.fields.push({
						"name": key,
						"value": sessionData[sessionToken].formData[key],
						"inline": false
					});
				}
				// Send the embed to the staff channel
				hook.send({embeds: [embed]});
				return res.render('success.ejs', {sessionData: sessionData[sessionToken]});
			});
		}
	}
	
});


// logout route, destroy the session
app.get('/logout', function (req, res) {
	req.session.destroy();
	res.redirect('/');
});

app.listen(config.port, function () {
	console.log("Logged in as.. this is for pterodactyl")
	console.clear();
	console.log(`${colors.cyan("[INFO]")} Listening on port ${colors.green(config.port)}`);
});
