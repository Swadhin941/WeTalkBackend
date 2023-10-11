const express = require("express");
const { MongoClient, ServerApiVersion } = require('mongodb');
const app = express();
const cors = require('cors');
require('dotenv').config();
const http = require('http');
const httpServer = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', "POST"],
    },
});
const port = process.env.PORT || 5000;
const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.acejzkz.mongodb.net/?retryWrites=true&w=majority`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});
const jwt = require('jsonwebtoken');


//MiddleWare
app.use(cors());
app.use(express.json());

const verifyJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send({ message: "Unauthorize access" });
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN, function (error, decoded) {
        if (error) {
            return res.status(401).send({ message: "Unauthorize Access" });
        }
        req.decoded = decoded;
        next();
    })
}



io.use((socket, next) => {
    if (Object.keys(socket.handshake.auth).length === 0) {
        const error = new Error("not_connected");
        error.data = { type: "not_connected" };
        next(error);
    }
    else {
        const authHeader = socket.handshake.auth.token;
        if (authHeader === null) {
            const error = new Error("empty_auth");
            error.data = { type: "authEmpty" };
            next(error);
        }
        const token = authHeader.split(' ')[1];
        jwt.verify(token, process.env.ACCESS_TOKEN, function (error, decoded) {
            // console.log(error.message);
            if (error) {
                const error = new Error('tokenError')
                error.data = { type: "tokenError" }
                next(error);
            }
            if (socket.handshake.auth.email !== decoded?.email) {
                const error = new Error("forbidden");
                error.data = { type: "forbiddenAccess" };
                next(error);
            }
            next();
        })
    }

})


//Api from here
const run = async () => {
    const users = client.db('ChattingApp').collection('Users');
    const allMessages = client.db('ChattingApp').collection('allMessages');
    const allRooms = client.db('ChattingApp').collection('allRooms');
    try {
        app.get('/', async (req, res) => {
            res.send("Server is running perfectly")
        })

        //User post here
        app.post('/user', async (req, res) => {
            const email = req.body.email;

            const findEmail = await users.findOne({ email });
            if (!findEmail) {
                const result = await users.insertOne(req.body);
                return res.send(result);
            }
            else {
                const result = { acknowledged: true };
                return res.send(result);
            }
        });


        app.get('/getUserDetails', verifyJWT, async (req, res) => {
            const email = req.query.user;
            // console.log(email, req.decoded.email);
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: "Forbidden Access" });
            }
            const result = await users.findOne({ email: email });
            res.send(result);
        });

        app.patch('/updateUser', verifyJWT, async (req, res) => {
            const email = req.query.user;
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: "Forbidden Access" });
            }
            const filter = { email: email };
            const updatedDoc = {
                $set: {
                    ...req.body
                }
            }
            const option = { upsert: true };
            const result = await users.updateOne(filter, updatedDoc, option);
            res.send(result)
        })

        app.get("/allTextedPerson", verifyJWT, async (req, res) => {
            const email = req.query.user;
            console.log(email, req.decoded.email)
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: "Forbidden Access" });
            }
            const user = req.query.user;
            let allUserList = await users.find({ email: { $ne: user } }).toArray();
            let allMessagesOfUser = await allMessages.find({ $or: [{ sender: user }, { receiver: user }] }).sort({ currentTimeMili: -1 }).toArray();
            // console.log(allMessagesOfUser);
            allUserList.forEach(element => {
                const findLastMessage = allMessagesOfUser.find(data => (data.sender === user && data.receiver === element.email) || (data.sender === element.email && data.receiver === user));
                element.data = findLastMessage?.data;
                element.currentTimeMili = findLastMessage?.currentTimeMili
            })
            // console.log(typeof JSON.stringify({allUserList}));
            res.send(allUserList);
        });

        app.post('/getAllMessages', verifyJWT, async (req, res) => {
            const email = req.query.user;
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: "Forbidden access" });
            }
            const query = { $or: [{ $and: [{ sender: req.query.user }, { receiver: req.query.to }] }, { $and: [{ sender: req.query.to }, { receiver: req.query.user }] }] }
            const availabilityCheck = await allRooms.findOne(query);
            let result = await allMessages.find(query).sort({ currentTimeMili: 1 }).toArray();
            // console.log( "result",typeof(result));
            if (!availabilityCheck) {
                await allRooms.insertOne({ sender: req.body.selectedPerson.sender, receiver: req.body.selectedPerson.receiver, roomAddress: req.body.selectedPerson.roomAddress });
                return res.send([result, { roomAddress: req.body.selectedPerson.roomAddress }])
            }
            else {
                if (availabilityCheck?.blocked) {
                    const tempData = [...availabilityCheck?.blocked];
                    const filterSpecificEmail = tempData.filter(data => data.blockedBy === req.query.user);
                    if (filterSpecificEmail.length !== 0) {
                        return res.send([result, { roomAddress: availabilityCheck.roomAddress, blockedBy: filterSpecificEmail[0].blockedBy }]);
                    }
                    else {
                        const findBlockedEmail = tempData.find(data => data.blockedBy !== req.query.user);
                        return res.send([result, { roomAddress: availabilityCheck.roomAddress, blockedBy: findBlockedEmail?.blockedBy }]);
                    }
                }
                return res.send([result, { roomAddress: availabilityCheck.roomAddress }]);
            }
        });

        //Unblock_data_for_current_user
        app.get('/Unblock_data_for_current_user', verifyJWT, async (req, res) => {
            const roomAddress = req.query.roomAddress;
            const roomStatus = await allRooms.findOne({ roomAddress: roomAddress });
            if (roomStatus?.blocked) {
                const findEmail = roomStatus.blocked.find(email => email.blockedBy !== req.query.user);
                if (findEmail) {
                    return res.send({ blockedBy: findEmail.blockedBy });
                }
                else {
                    return res.send({});
                }
            }
            else {
                return res.send({});
            }
        });

        //JWT token from here
        app.get('/jwt', async (req, res) => {
            const email = req.query.user;
            const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: '1hr' });
            res.send({ token: token });
        })

        io.on("connection", (socket) => {
            console.log("Connection Established");
            socket.on('joinRoom', (data) => {
                // console.log("room number: ", data.roomAddress);

                socket.join(data.roomAddress);
            })

            socket.on("reactEvent", async (message, callback) => {
                const authHeader = message.token;
                if (!authHeader) {
                    callback({
                        status: "Denied"
                    })
                }
                const token = authHeader.split(' ')[1];
                jwt.verify(token, process.env.ACCESS_TOKEN, async function (error, decoded) {
                    // console.log(error.message);
                    if (error) {
                        callback({
                            status: "Denied"
                        })
                    }
                    else if (message.email !== decoded?.email) {
                        callback({
                            status: "Forbidden"
                        })
                    }
                    else {
                        // console.log("reactEvent", message);
                        await allMessages.insertOne(message);
                        // console.log("react event", message);
                        socket.to(message?.roomAddress).emit('showMessage', { ...message });
                        callback({
                            status: "Send"
                        })
                    }
                })
            })
            socket.on('typing', (data, callback) => {
                const authHeader = data.token
                if (!authHeader) {
                    console.log("247", authHeader);
                    callback({
                        status: "Denied"
                    })
                }
                const token = authHeader.split(' ')[1];
                jwt.verify(token, process.env.ACCESS_TOKEN, function (error, decoded) {
                    // console.log(error.message);
                    if (error) {
                        callback({
                            status: "Denied"
                        })
                    }
                    else if (data.email !== decoded?.email) {
                        callback({
                            status: "Forbidden"
                        })
                    }
                    else {
                        socket.to(data.joinRoom).emit("typing", { data: data.data });
                    }
                })

            });

            socket.on('blockRequest', async (data) => {
                const authHeader = data.token;
                if (!authHeader) {
                    callback({
                        status: "Denied"
                    })
                }
                const token = authHeader.split(' ')[1];
                jwt.verify(token, process.env.ACCESS_TOKEN, async function (error, decoded) {
                    // console.log(error.message);
                    if (error) {
                        callback({
                            status: "Denied"
                        })
                    }
                    else if (data.email !== decoded?.email) {
                        callback({
                            status: "Forbidden"
                        })
                    }
                    else {
                        const getDetails = await allRooms.findOne({ roomAddress: data.roomAddress });
                        // console.log("201", getDetails);
                        if (getDetails?.blocked) {
                            let tempData = [...getDetails?.blocked, { blockedBy: data.sender }]
                            // console.log(tempData);
                            const filter = { roomAddress: data.roomAddress };
                            const updatedDoc = {
                                $set: {
                                    blocked: tempData
                                }
                            };
                            const option = { upsert: true };
                            const updateRoom = await allRooms.updateOne(filter, updatedDoc, option);
                            const filterSpecificEmail = tempData.filter(email => email.blockedBy !== data.sender);
                            // console.log(filterSpecificEmail);
                            if (filterSpecificEmail.length !== 0) {
                                socket.to(data.roomAddress).emit('blockDetails', { blockedBy: filterSpecificEmail[0].blockedBy })
                            }
                            else {
                                const findBlockedEmail = tempData.find(email => email.blockedBy === data.sender);
                                socket.to(data.roomAddress).emit("blockDetails", { blockedBy: findBlockedEmail.blockedBy })
                            }
                        }
                        else {
                            const blocked = [
                                {
                                    blockedBy: data.sender
                                }
                            ];
                            const filter = { roomAddress: data.roomAddress };
                            const updatedDoc = {
                                $set: {
                                    blocked: blocked
                                }
                            }
                            const option = { upsert: true };
                            const updatedPerson = await allRooms.updateOne(filter, updatedDoc, option);
                            socket.to(data.roomAddress).emit('blockDetails', { blockedBy: data.sender });
                        }
                    }
                    // console.log("blockRequest", data);
                })
            });

            socket.on('UnblockRequest', async (data) => {
                // console.log("UnblockRequest", data);
                const authHeader = socket.handshake.auth.token;
                if (!authHeader) {
                    callback({
                        status: "Denied"
                    })
                }
                const token = authHeader.split(' ')[1];
                jwt.verify(token, process.env.ACCESS_TOKEN, async function (error, decoded) {
                    // console.log(error.message);
                    if (error) {
                        callback({
                            status: "Denied"
                        })
                    }
                    else if (socket.handshake.auth.email !== decoded?.email) {
                        callback({
                            status: "Forbidden"
                        })
                    }
                    else {
                        const getRoomInfo = await allRooms.findOne({ roomAddress: data.roomAddress });
                        // console.log(getRoomInfo);
                        const getRemainingBlock = getRoomInfo?.blocked.filter((email) => email.blockedBy !== data.sender);

                        // console.log(getRemainingBlock);
                        if (getRemainingBlock.length !== 0) {
                            const filter = { roomAddress: data.roomAddress };
                            const updatedDoc = {
                                $set: {
                                    blocked: getRemainingBlock
                                }
                            }
                            const option = { upsert: true };
                            const result = await allRooms.updateOne(filter, updatedDoc, option);
                            socket.to(data.roomAddress).emit('UnblockDetails', { blockedBy: getRemainingBlock[0].blockedBy })
                        }
                        else {
                            const filter = { roomAddress: data.roomAddress };
                            const updatedDoc = {
                                $set: {
                                    sender: getRoomInfo.sender,
                                    receiver: getRoomInfo.receiver,
                                    roomAddress: getRoomInfo.roomAddress
                                }
                            };
                            const option = { upsert: true };
                            // console.log(updatedDoc);
                            const result = await allRooms.updateOne(filter, { $unset: { blocked: 1 } }, { multi: false });
                            if (result.modifiedCount >= 1) {
                                socket.to(data.roomAddress).emit("UnblockDetails", { blockedBy: false })
                            }
                        }
                    }
                })

            })

            socket.on("disconnect", (socket) => {
                console.log("Connection Disconnected");
            })
        });
    }
    finally {

    }
}
run()
    .catch(error => {
        console.log(error.message);
    })

httpServer.listen(port, () => {
    console.log('listening on port ', port);
})