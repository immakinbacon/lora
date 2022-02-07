const fs = require('fs');
const zlib = require("zlib");
const tuntap = require('../node_modules/@findoff/node-tuntap/index.js');
const crypto = require("crypto");
const args = process.argv.slice(2);
const configJSON = fs.readFileSync(args[0]);
const config = JSON.parse(configJSON);
var recvHashData = [];
var recvHashControl = [];
var transmitBuffer = [];
var transmitWait = 0;
var totalTime = 0;
var totalBytes = 0;
var receiveBufferIndex = [];
var receiveBuffer = [];
var transmitWaitMax = config['transmitWaitMax'];
var transmitWaitMin = config['transmitWaitMin'];
var waitPerByte = config['waitPerByte'];
try {
	var tt = tuntap({
		type: config['interfaceType'],
		name: config['interfaceName'],
		mtu: parseInt(config['mtu']),
		addr: config['address'],
		dest: config['address'],
		mask: config['mask'],
		ethtype_comp: 'half',
		persist: false,
		up: true,
		running: true,
	});
}
catch(e) {
	log(5,'Tuntap creation error: ', e);
	process.exit(0);
}
if (config['mode'] == "telnet")
{
	var TelnetSocket, net, socket, tSocket;
	net = require("net");
	({ TelnetSocket } = require("telnet-stream"));
	socket = net.createConnection(parseInt(config['destinationPort']),config['destination']);
	tSocket = new TelnetSocket(socket);
	tSocket.on("data", function (buffer) {
		 loraReceive(buffer);
	});
	tt.on("data", function (buffer) {
		ethernetCompress(buffer);
	});
	function loraTransmit(buffer) { tSocket.write(buffer); }
}
if (config['mode'] == "serial")
{
	var SerialPort = require("serialport");
	var serialPort = new SerialPort(config['destination'],parseInt(config['serialSpeed']));
	serialPort.on("data", function (buffer) {
		loraReceive(buffer);
	});
	tt.on("data", function (buffer) {
		ethernetCompress(buffer);
	});
	function loraTransmit(buffer) { serialPort.write(buffer); }
}
function ethernetCompress(buffer)
{
	hash = crypto.createHash('md5').update(buffer.toString("utf8")).digest("base64");
	log(1,"Packet received from "+config['interfaceName']+" containing "+buffer.length+" bytes. Hash is "+hash);
	log(10,logEthernet(buffer));
	compressedPacket = zlib.deflateSync(buffer);
	ethernetReceive(compressedPacket);
	log(1,"Ethernet packet compressed to "+compressedPacket.length+" bytes.");
}
function ethernetReceive(buffer)
{
	packetBuffer = [];
	packetId = randomString(4);
	for(i=0; i<buffer.length; i+=234)
	{
		packet = [];
		packet.push(Buffer.from("01"+packetId,'utf-8'));
		packet.push(buffer.slice(i,i+234));
		packetBuffer.push(Buffer.concat(packet));
	}
	log(3,"Adding control packet 00"+packetId+(Buffer.concat(packetBuffer).length)+" to transmit buffer");
	transmitBuffer.push("00"+packetId+(Buffer.concat(packetBuffer).length));
	packetBuffer.forEach(function(packet) {
		packetId = packet.slice(0,4).toString();
		log(3,"Adding Ethernet packet "+packetId+" of "+packet.length+" bytes to transmit buffer");
		transmitBuffer.push(packet);
	});
}
function loraReceive(buffer)
{
	log(1,"Packet received from Lora");
	packetReceiveTime = new Date().getTime();
	taskId = buffer.slice(0,2);
	packetId = buffer.slice(2,6).toString();
	hash = crypto.createHash('md5').update(buffer.toString("utf8")).digest("base64");
	if (taskId == 00)
	{
		log(1,"Packet is a control packet");
		if (recvHashControl.indexOf(hash) == -1)
		{
			log(1,"Control packet has a packetId of "+packetId);
			log(1,"Packet index is "+(receiveBufferIndex.push(packetId)-1)+" for packetId "+packetId);
			packetLength = buffer.slice(6).toString();
			receiveBuffer.push([packetLength,packetReceiveTime,[]]);
			if (isNaN(packetLength) === false)
			{
				transmitWait = packetReceiveTime+(waitPerByte*packetLength)+random(transmitWaitMin,transmitWaitMax);
				log(2,"Setting wait time to "+(waitPerByte*packetLength)+"ms. Current wait per byte is "+waitPerByte+"ms");
			}else{ log(1,"Packet length is not a number unable to update transmitWait. This could cause packet loss"); }
			recvHashControl.push(hash);
		}else{ log(2,"Control packet is duplicate, discarding."); }
		if (recvHashControl.length > config['dedupHistoryControl']) { recvHashControl.shift(); }
	}
	if (taskId == 01)
	{
		log(1,"Packet is a Ethernet packet");
		if (recvHashData.indexOf(hash) == -1)
		{
			packetIndex = receiveBufferSearch(packetId);
			log(1,"Ethernet packet received has a packetId of "+packetId);
			if (packetIndex >= 0)
			{
				packetData = buffer.slice(6);
				log(1,"Packet received has a length of "+packetData.length);
				receiveBuffer[packetIndex][2].push(packetData);
				receiveBuffer[packetIndex][0] -= 6;
				log(1,"There are currently "+receiveBuffer[packetIndex][2].length+" packets in the buffer with this packetId");
				dataInBuffer = Buffer.concat(receiveBuffer[packetIndex][2]);
				if (((packetReceiveTime-receiveBuffer[packetIndex][1])/buffer.length) < config['waitToDiscard'])
				{
					totalBytes += buffer.length;
					totalTime += packetReceiveTime-receiveBuffer[packetIndex][1];
					waitPerByte = Math.round(totalTime/totalBytes);
				}
				if (receiveBuffer[packetIndex][0] == dataInBuffer.length)
				{
					log(1,packetId+" has been rebuilt with a length of "+dataInBuffer.length+" bytes.");
					try {
						decompressedPacket = zlib.inflateSync(dataInBuffer);
						log(1, packetId+" has been decompressed to a length of "+decompressedPacket.length);
						tt.write(decompressedPacket);
						log(10,logEthernet(decompressedPacket));
						hash = crypto.createHash('md5').update(decompressedPacket.toString("utf8")).digest("base64");
						log(1,packetId+" has been rebuilt, sending "+decompressedPacket.length+" bytes out ethernet interface and clearing buffer. Hash is "+hash);
					}catch (err) {
						log(1, packetId+" is corrupt unable to decompress. Discarding packet ");
					}
					receiveBuffer.splice(packetIndex,1);
					receiveBufferIndex.splice(packetIndex,1);
				}else{ log(1,"Expecting buffer length to be "+receiveBuffer[packetIndex][0]+" buffer is currently only "+dataInBuffer.length+" bytes"); }
				recvHashData.push(hash);
			}
		}else{ log(2,"Ethernet packet is duplicate, discarding."); }
		if (recvHashData.length > config['dedupHistoryControl']) { recvHashData.shift(); }
	}
}
setInterval(() => {
	if (transmitBuffer.length > 0 && transmitWait < new Date().getTime())
	{
		log(2,"Wait timer expired, processing queue length of "+transmitBuffer.length+". Current wait per byte is "+waitPerByte+"ms");
		hash = crypto.createHash('md5').update(transmitBuffer[0].toString("utf8")).digest("base64");
		taskId = transmitBuffer[0].slice(0,2);
		if (taskId == 00)
		{
			log(2,"Sending control packet with the length of "+transmitBuffer[0].length+" and payload of "+transmitBuffer[0]);
			loraTransmit(transmitBuffer[0]);
			recvHashControl.push(hash);
			if (recvHashControl.length > config['dedupHistoryControl']) { recvHashControl.shift(); }
		}
		if (taskId == 01)
		{
			log(2,"Sending "+transmitBuffer[0].slice(0,4)+" Ethernet packet with the length of "+transmitBuffer[0].length);
			loraTransmit(transmitBuffer[0]);
			recvHashData.push(hash);
			if (recvHashData.length > config['dedupHistoryData']) { recvHashData.shift(); }
		}
		if (isNaN(transmitBuffer[0].length) === false)
		{
			log(2,"Setting wait time to "+((waitPerByte*transmitBuffer[0].length)+random(transmitWaitMin,transmitWaitMax))+"ms. Current wait per byte is "+waitPerByte+"ms");
			transmitWait = new Date().getTime()+((waitPerByte*transmitBuffer[0].length)+random(transmitWaitMin,transmitWaitMax));
		}else{ log(1,"Packet length is not a number unable to update transmitWait. This could cause packet loss"); }
		transmitBuffer.shift();
	}
}, 1);
setInterval(() => {
	currentTime = new Date().getTime();
	receiveBuffer.forEach(function(packet,packetIndex)
	{
		if (currentTime > (packet[1]+(parseInt(config['packetTimeout'])*1000)))
		{
			log(4,"Packet "+receiveBufferIndex[packetIndex]+" has expired from the receive buffer. Removing packet definitions");
			receiveBuffer.splice(packetIndex,1);
			receiveBufferIndex.splice(packetIndex,1);
		}
	});
}, 1000);
function receiveBufferSearch(packetId) { index = receiveBufferIndex.indexOf(packetId); log(4,"Packet definition search result for "+packetId+" is "+index); return index; }
function log(level,message) { if (level <= parseInt(config['debugLevel'])) { console.log(new Date().toISOString()+" - "+message); }}
function random(min,max) { return Math.floor(Math.random() * max-min) + min; }
function randomString(length) {
	var result = '';
	var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	var charactersLength = characters.length;
	for (i=0; i<length; i++)
	{
		result += characters.charAt(Math.floor(Math.random() * charactersLength));
	}
	return result;
}
function logEthernet(packet) {
	logMessage = "Per packet logging enabled\r\n\r\n"
	packetBinary = "";
	packet.toString('hex').match(/.{1,2}/g).forEach(function(hex) { packetBinary += parseInt(hex,16).toString(2).padStart(8,'0'); });
	if (config['interfaceType'] == "tap") {
		macDestination = packetBinary.substr(32,24);
		macSource = packetBinary.substr(56,24);
		etherType = packetBinary.substr(80,8);
		logMessage += "Destination MAC:"+macDestination+"\r\nSource MAC:"+macSource+"\r\n";	
		if (etherType == "0800") {
			logMessage += "Ethernet Frame Type: IPV4\r\n";
			ipv4Packet = packetBinary.substr(88,-64);
		}
	}else{ ipv4Packet = packetBinary.substr(16); }
	ipv4Length = parseInt(ipv4Packet.substr(16,16),2)*8;
	ipv4IHL = parseInt(ipv4Packet.substr(4,4),2)*32;
	ipv4Protocol = parseInt(ipv4Packet.substr(72,8),2);
	ipv4Source = parseInt(ipv4Packet.substr(96,8),2)+"."+parseInt(ipv4Packet.substr(104,8),2)+"."+parseInt(ipv4Packet.substr(112,8),2)+"."+parseInt(ipv4Packet.substr(120,8),2);
	ipv4Destination = parseInt(ipv4Packet.substr(128,8),2)+"."+parseInt(ipv4Packet.substr(136,8),2)+"."+parseInt(ipv4Packet.substr(144,8),2)+"."+parseInt(ipv4Packet.substr(152,8),2);
	ipv4Payload = ipv4Packet.substr(ipv4Length*-1);
	logMessage += "Destination IPv4 Address: "+ipv4Destination+"\r\nSource IPv4 Address: "+ipv4Source+"\r\nLength: "+ipv4Length/8+"\r\nProtocol: ";
	switch (ipv4Protocol) {
		case 1: logMessage += "ICMP";break;
		case 6: logMessage += "TCP";break;
		case 17: logMessage += "UDP";break;
		default: logMessage += ipv4Protocol;
	}
	logMessage += "\r\n";
	ipv4Payload.substr((ipv4Length-ipv4IHL)*-1).match(/.{8}/g).forEach(function(binary) { logMessage += parseInt(binary,2).toString(16).toUpperCase().padStart(2,'0')+" "; });
	return logMessage+"\r\n";
}
