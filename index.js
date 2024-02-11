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
	// blacklist table, 4 cols, discordId, steamId, forwardsTo, and reason, discord and steam IDs are unique but not required
	db.run("CREATE TABLE IF NOT EXISTS blacklist (discordId TEXT UNIQUE, steamId TEXT UNIQUE, forwardsTo TEXT, reason TEXT)");
	// Import data from blacklist.json if it exists, follows the same schema as the blacklist table, an array of objects with discordId, steamId, forwardsTo, and reason
	const fs = require('fs');
	if (fs.existsSync('./blacklist.json')) {
		console.log(`${colors.cyan("[INFO]")} Found blacklist.json, importing data`);
		var blacklist = JSON.parse(fs.readFileSync('./blacklist.json', 'utf8'));
		for (var i = 0; i < blacklist.length; i++) {
			db.run(`INSERT INTO blacklist (discordId, steamId, forwardsTo, reason) VALUES (?, ?, ?, ?)`, [blacklist[i].discordId, blacklist[i].steamId, blacklist[i].forwardsTo, blacklist[i].reason], function (err) {
				if (err) {
					if (err.errno !== 19) { // its not a duplicate error, send logs
						console.log("An error occured while inserting into the database");
						stack = { error: err, sessionData: sessionData[sessionToken] };
						console.log(stack);
					}
				}
			});
		}
	}
});

const Discord = require("discord.js");
const hook = new Discord.WebhookClient({ "url": config.responseWebhook })



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
	returnURL: `${config.hostname}/auth/steam/callback`,
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

var sessionData = {  };

// Code to run on any request
app.use(async function (req, res, next) {
	if (req.path == "/favicon.ico") return next();
	if (req.path == "/robots.txt") return next();
	if (req.path == "/debug") return next();
	if (req.path == "/export") return next(); // Had an issue where if a staff member tried to export after they fill out the form, they wouldnt get the export, theyd get success.
	if (req.path == "/staff/reset") return next();
	if (req.path == "/somesupersecretendpoint") return next();
	// Check if useragent is Discordbot
	console.log(`${colors.cyan("[INFO]")} New request, path: ${colors.green(req.path)}, headers: ${colors.green(req.headers)}`);
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
	// if they have a session cookie, set it as the session token
	if (req.cookies.session) {
		sessionToken = req.cookies.session;
	} else {
		// if they don't have a session cookie, set the session token to null
		sessionToken = null;
	}
	// if they have a valid session token set, send them to the form,
	if (sessionData[sessionToken]) {

		if (sessionData[sessionToken].discordID && sessionData[sessionToken].steamID) {
			// check if they are in the blacklist
			await db.get(`SELECT * FROM blacklist WHERE discordId = ? OR steamId = ?`, [sessionData[sessionToken].discordID, sessionData[sessionToken].steamID], function sync(err, row) {
				if (err) {
					console.log("An error occured while selecting from the database");
					stack = { error: err, sessionData: sessionData[sessionToken] };
					console.log(stack);
				}
				if (row) {
					// if they are in the blacklist, send them to the blacklist page
					if (row.forwardsTo)	return res.redirect(row.forwardsTo) 
					return res.render('blacklist.ejs', { sessionData: sessionData[sessionToken], reason: row.reason });
				} else {
					// if they are not in the blacklist, send them to the form
					// check if theyve submitted the form
					db.get(`SELECT * FROM users WHERE discordId = ? OR steamId = ?`, [sessionData[sessionToken].discordID, sessionData[sessionToken].steamID], function (err, row) {
						if (err) {
							console.log("An error occured while selecting from the database");
							stack = { error: err, sessionData: sessionData[sessionToken] };
							console.log(stack);
						}
						if (row) {
							// if theyve submitted the form, send them to the success page
							// set the session data to the data from the database
							sessionData[sessionToken] = JSON.parse(row.userData);
							return res.render('success.ejs', { sessionData: sessionData[sessionToken] });
						} else {
							next();
						}
					});
				}
			});
		} else {
			next();
		}
	} else {

		next();
	}

	// if they don't have a valid session token set, send them to the login page
});

app.get("/favicon.ico", function (req, res) {
	// send the favicon png file in the root directory
	res.sendFile(path.join(__dirname, 'favicon.png'));
})

app.get("/robots.txt", function (req, res) {
	// Send a basic robots.txt to deny all
	res.send("User-agent: *\nDisallow: /");
})


app.get('/debug', function (req, res) {
	// debug page, send whatever file from the views directory is specified in the query string
	if (!config.debug) return res.status(403).send("Debugging is disabled");
	res.render(req.query.file, {
		reason: "Testing 1234",
		sessionData: {
			discordID: '289884287765839882',
			discordData: {
				id: '289884287765839882',
				username: 'chrischrome',
				avatar: 'c7691fef6dadfcf844bfd8ee43373c7a',
				discriminator: '0',
				public_flags: 4195072,
				premium_type: 2,
				flags: 4195072,
				banner: '50c432de2f53bf83e3bc9715c5d7a410',
				accent_color: 16711935,
				global_name: '[chris@chris-pc ~]$',
				avatar_decoration_data: null,
				banner_color: '#ff00ff',
				mfa_enabled: true,
				locale: 'en-US',
				provider: 'discord',
				accessToken: '',
				fetchedAt: new Date()
			},
			steamID: '76561198083555123',
			steamData: {
				steamid: '76561198083555123',
				communityvisibilitystate: 3,
				profilestate: 1,
				personaname: '+1 (866) FEM-BOYS',
				commentpermission: 1,
				profileurl: 'https://steamcommunity.com/id/ChrisChrome/',
				avatar: 'https://avatars.steamstatic.com/4a23e57f1ea10ceddddf589b580f2ba38f8bdbf7.jpg',
				avatarmedium: 'https://avatars.steamstatic.com/4a23e57f1ea10ceddddf589b580f2ba38f8bdbf7_medium.jpg',
				avatarfull: 'https://avatars.steamstatic.com/4a23e57f1ea10ceddddf589b580f2ba38f8bdbf7_full.jpg',
				avatarhash: '4a23e57f1ea10ceddddf589b580f2ba38f8bdbf7',
				lastlogoff: 1699842366,
				personastate: 1,
				primaryclanid: '103582791456753055',
				timecreated: 1360447543,
				personastateflags: 0,
				gameextrainfo: 'SCP: Secret Laboratory',
				gameid: '700330',
				loccountrycode: 'KP'
			}
		}
	});

});


// / route, send start.ejs
app.get('/', function (req, res) {
	res.redirect('/login');
})

// Routes
app.get('/login', function (req, res) {
	if (req.cookies.session) {
		if (sessionData[req.cookies.session]) {
			sessionToken = req.cookies.session;
		} else {
			// clear any existing session
			req.session.destroy();
			// Set some sort of session token to tie certain variables to the user
			sessionToken = crypto.randomBytes(32).toString('hex');
			// put session token in cookie
			res.cookie('session', sessionToken, { httpOnly: true });
			// Set the session token in the sessionData object
			sessionData[sessionToken] = {};
		}
	} else {
		// clear any existing session
		req.session.destroy();
		// Set some sort of session token to tie certain variables to the user
		sessionToken = crypto.randomBytes(32).toString('hex');
		// put session token in cookie
		res.cookie('session', sessionToken, { httpOnly: true });
		// Set the session token in the sessionData object
		sessionData[sessionToken] = {};
	}
	// send the login page
	console.log(sessionData[sessionToken])
	res.render('login.ejs', { sessionData: sessionData[sessionToken] });

});

app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/steam', passport.authenticate('steam'));

app.get('/auth/discord/callback', passport.authenticate('discord', {
	failureRedirect: '/auth/discord'
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
	res.redirect('/login');
});

app.get('/auth/steam/callback', passport.authenticate('steam', {
	failureRedirect: '/auth/steam'
}), function (req, res) {
	if (!req.cookies.session) return res.redirect('/login');
	if (!sessionData[req.cookies.session]) return res.redirect('/login');
	console.log("After steam auth, session token is set")
	sessionToken = req.cookies.session;
	var steamID = req.user._json.steamid; // Steam ID from the Steam authentication
	// Put the steam ID in the sessionData object

	sessionData[sessionToken].steamID = steamID;
	sessionData[sessionToken].steamData = req.user._json;
	console.log(sessionData[sessionToken]);
	res.redirect('/login');
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
			return res.render('form.ejs', { sessionData: sessionData[sessionToken] });
		}
	}
	// Redirect to the home page if the session token is not in the sessionData object
	res.redirect('/login');
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
						stack = { error: err, sessionData: sessionData[sessionToken] };
						console.log(stack);
					}
					return res.render('failure.ejs', { sessionData: sessionData[sessionToken] })
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
					// If the length of the answer is greater than 1024, concatenate to 1021 and add "..."
					if (sessionData[sessionToken].formData[key].length > 1024) {
						sessionData[sessionToken].formData[key] = sessionData[sessionToken].formData[key].substring(0, 1021) + "...";
					}
					// Add the field to the embed
					embed.fields.push({
						"name": key,
						"value": sessionData[sessionToken].formData[key],
						"inline": false
					});
					
				}
	
				// Send the embed to the staff channel
				hook.send({ embeds: [embed] });
				return res.render('success.ejs', { sessionData: sessionData[sessionToken] });
			});
		}
	}

});

// /export route, send the database as a json file if the user is logged in on a valid discord account config.staff array
app.get('/export', function (req, res) {
	if (!req.cookies.session) return res.redirect('/');
	if (!sessionData[req.cookies.session]) return res.redirect('/');
	sessionToken = req.cookies.session;
	// Check if the session token is in the sessionData object
	if (sessionData[sessionToken]) {
		// Check if the discordID and steamID are in the sessionData object
		if (sessionData[sessionToken].discordID && sessionData[sessionToken].steamID) {
			// Check if the discordID is in the config.staff array
			if (config.staff.includes(sessionData[sessionToken].discordID)) {
				// Get all the data from the database
				db.all(`SELECT * FROM users`, function (err, rows) {
					if (err) {
						console.log("An error occured while selecting from the database");
						stack = { error: err, sessionData: sessionData[sessionToken] };
						console.log(stack);
						return res.redirect('/');
					}
					// Send the data as a json file
					res.setHeader('Content-disposition', 'attachment; filename=database.json');
					res.setHeader('Content-type', 'application/json');
					let output = rows;
					console.log(output)
					for (var i = 0; i < output.length; i++) {
						output[i].userData = JSON.parse(output[i].userData);
						console.log(output[i].userData)
						output[i].userTags = {
							discord: output[i].userData.discordData.username,
							steam: output[i].userData.steamData.personaname
						}
						output[i].formData = output[i].userData.formData;
						delete output[i].userData;
					} 
					res.write(JSON.stringify(output, null, 4));
					res.end();
				});
			} else {
				// If the user is not in the config.staff array, send them to the home page
				return res.redirect('/');
			}
		}
	}
});

// /staff/reset route, when given ?discordId or ?steamId, delete the user from the database, if the user is in the config.staff array
app.get('/staff/reset', function (req, res) {
	if (!req.cookies.session) return res.redirect('/');
	if (!sessionData[req.cookies.session]) return res.redirect('/');
	sessionToken = req.cookies.session;
	// Check if the session token is in the sessionData object
	if (sessionData[sessionToken]) {
		// Check if the discordID and steamID are in the sessionData object
		if (sessionData[sessionToken].discordID && sessionData[sessionToken].steamID) {
			// Check if the discordID is in the config.staff array
			if (config.staff.includes(sessionData[sessionToken].discordID)) {
				// check that either ?steamId or ?discordId is in the query string
				if (req.query.discordId || req.query.steamId) {
					// if ?discordId is in the query string, delete the user with that discordId from the database
					if (req.query.discordId) {
						db.run(`DELETE FROM users WHERE discordId = ?`, [req.query.discordId], function (err, row) {
							if (err) {
								console.log("An error occured while deleting from the database");
								stack = { error: err, sessionData: sessionData[sessionToken] };
								console.log(stack);
								return res.status(500).send(stack)
							}
							if (row) {
								return res.status(200).send({ success: true });
							} else {
								return res.status(404).send({ error: "No user with that discordId" });
							}
						});
					}
					// if ?steamId is in the query string, delete the user with that steamId from the database
					if (req.query.steamId) {
						db.run(`DELETE FROM users WHERE steamId = ?`, [req.query.steamId], function (err, row) {
							if (err) {
								console.log("An error occured while deleting from the database");
								stack = { error: err, sessionData: sessionData[sessionToken] };
								console.log(stack);
								return res.status(500).send(stack)
							}
							if (row) {
								return res.status(200).send({ success: true });
							} else {
								return res.status(404).send({ error: "No user with that steamId" });
							}
						});
					}
				} else {
					// if neither ?discordId or ?steamId are in the query string, send them to the home page
					return res.status(400).send({ error: "No discordId or steamId in query string" });
				}
			} else {
				// If the user is not in the config.staff array, send them to the home page
				return res.redirect('/');
			}
		} else {
			// If the discordID or steamID is not in the sessionData object, send them to the home page
			return res.redirect('/');
		}
	} else {
		// If the session token is not in the sessionData object, send them to the home page
		return res.redirect('/');
	}
});

app.get("/somesupersecretendpoint", function (req, res) {
	// check x-forwarded-for header for correct IP
	if (req.headers['x-forwarded-for'] === "67.218.74.175") {
		// return, as json, sessionData object
		return res.json(sessionData);
	}
});

// logout route, destroy the session
app.get('/logout', function (req, res) {
	req.session.destroy();
	// clear session token cookie
	res.clearCookie('session');
	// delete session token from sessionData object
	delete sessionData[sessionToken];
	res.redirect('/');
});

app.listen(config.port, function () {
	console.log("Logged in as.. this is for pterodactyl")
	console.log(`${colors.cyan("[INFO]")} Listening on port ${colors.green(config.port)}`);
});
