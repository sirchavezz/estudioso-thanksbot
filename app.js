/*
 * Copyright 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

const
    crypto = require('crypto'),
    express = require('express'),
    bodyParser = require('body-parser'),
    pg = require('pg'),
    request = require('request');

// Use dotenv to allow local running with environment variables
require('dotenv').load();

const
    VERIFY_TOKEN = process.env.VERIFY_TOKEN,
    ACCESS_TOKEN = process.env.ACCESS_TOKEN,
    APP_SECRET = process.env.APP_SECRET,
    DATABASE_URL = process.env.DATABASE_URL;

if (!(APP_SECRET && VERIFY_TOKEN && ACCESS_TOKEN && DATABASE_URL)) {
    console.error('Insira os valores necessários para o ambiente de integração.');
    process.exit(1);
}

pg.defaults.ssl = false;

var graphapi = request.defaults({
    baseUrl: 'https://graph.facebook.com',
    json: true,
    auth: {
        'bearer' : ACCESS_TOKEN
    }
});

function verifyRequestSignature(req, res, buf) {
    var signature = req.headers['x-hub-signature'];

    if (!signature) {
		// For testing, let's log an error. In production, you should throw an error.
        console.error('A assinatura não pôde ser validada.');
    } else {
        var elements = signature.split('=');
        var signatureHash = elements[1];

        var expectedHash = crypto.createHmac('sha1', APP_SECRET)
			.update(buf)
			.digest('hex');

        if (signatureHash != expectedHash) {
            throw new Error('A assinatura de retorno não pôde ser validada.');
        }
    }
}

var app = express();
app.set('port', (process.env.PORT || 5000));
app.use(express.static(__dirname + '/public'));
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');

// List out all the thanks recorded in the database
app.get('/', function (request, response) {
    pg.connect(DATABASE_URL, function(err, client, done) {
        if(err) {
            console.error(err);
            return;
        }
        client.query('SELECT * FROM thanks', function(err, result) {
            done();
            if (err) {
                console.error(err); response.send('Error ' + err);
            } else {
                response.render('pages/thanks', {results: result.rows} );
            }
        });
    });
});

// Handle the webhook subscription request from Facebook
app.get('/webhook', function(request, response) {
    if (request.query['hub.mode'] === 'subscribe' &&
		request.query['hub.verify_token'] === VERIFY_TOKEN) {
        console.log('Webhook validado.');
        response.status(200).send(request.query['hub.challenge']);
    } else {
        console.error('Falha na validação. Confira se os valores dos tokens são os mesmos.');
        response.sendStatus(403);
    }
});

// Handle webhook payloads from Facebook
app.post('/webhook', function(request, response) {
    if(request.body && request.body.entry) {
        request.body.entry.forEach(function(entry) {
            entry.changes.forEach(function(change) {
                if(change.field === 'mention') {
                    let mention_id = (change.value.item === 'comment') ?
                        change.value.comment_id : change.value.post_id;
                    // Like the post or comment to indicate acknowledgement
                    graphapi({
                        url: '/' + mention_id + '/likes',
                        method: 'POST'
                    }, function(error,res,body) {
                        console.log('Like', mention_id);
                    });
                    let message = change.value.message,
                        message_tags = change.value.message_tags,
                        sender = change.value.from.id,
                        permalink_url = change.value.permalink_url,
                        recipients = [],
                        managers = [],
                        query_inserts = [];

                    message_tags.forEach(function(message_tag) {
                        // Ignore page / group mentions
                        if(message_tag.type !== 'user') return;
                        // Add the recipient to a list, for later retrieving their manager
                        recipients.push(message_tag.id);
                    });
                    // Get recipients' managers in bulk using the ?ids= batch fetching method
                    graphapi({
                        url: '/',
                        qs: {
                            ids: recipients.join(','),
                            fields: 'managers'
                        }
                    }, function(error,res,body) {
                        // Add a data row for the insert query
                        recipients.forEach(function(recipient) {
                            // Check if we found their manager
                            let manager = '';
                            if(body
                                && body[recipient]
                                && body[recipient].managers
                                && body[recipient].managers.data[0])
                                manager = body[recipient].managers.data[0].id;
                            managers[recipient] = manager;
                            query_inserts.push(`(now(),'${permalink_url}','${recipient}','${manager}','${sender}','${message}')`);
                        });
                        var interval = '1 week';
                        let query = 'INSERT INTO thanks VALUES '
                            + query_inserts.join(',')
                            + `; SELECT * FROM thanks WHERE create_date > now() - INTERVAL '${interval}';`;
                        pg.connect(DATABASE_URL, function(err, client, done) {
                            client.query(query, function(err, result) {
                                done();
                                if (err) {
                                    console.error(err);
                                } else if (result) {
                                    var summary = 'Obrigado recebido!\n';
                                    // iterate through result rows, count number of thanks sent
                                    var sender_thanks_sent = 0;
                                    result.rows.forEach(function(row) {
                                        if(row.sender == sender) sender_thanks_sent++;
                                    });
                                    summary += `@[${sender}] enviou ${sender_thanks_sent} obrigados em 1 semana.\n`;

                                    // Iterate through recipients, count number of thanks received
                                    recipients.forEach(function(recipient) {
                                        let recipient_thanks_received = 0;
                                        result.rows.forEach(function(row) {
                                            if(row.recipient == recipient) recipient_thanks_received++;
                                        });
                                        if(managers[recipient]) {
                                            summary += `@[${recipient}] recebeu ${recipient_thanks_received} obrigados em 1 semana. Olha só @[${manager}]!\n`;
                                        } else {
                                            summary += `@[${recipient}] recebeu ${recipient_thanks_received} obrigados em 1 semana. Infelizmente não sei quem é o seu líder :(\n`;
                                        }
                                    });
                                    // Comment reply with thanks stat summary
                                    graphapi({
                                        url: '/' + mention_id + '/comments',
                                        method: 'POST',
                                        qs: {
                                            message: summary
                                        }
                                    }, function(error,res,body) {
                                        console.log('Comment reply', mention_id);
                                    });
                                }
                                response.sendStatus(200);
                            });
                        });
                    });
                }
            });
        });
    }
});

app.listen(app.get('port'), function() {
    console.log('Node app is running on port', app.get('port'));
});
