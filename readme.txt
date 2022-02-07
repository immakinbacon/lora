Download NodeJS and supporting packages.

	apt install nodejs npm iptables iptables-persistent hostapd dnsmasq
	mkdir /lora
	cd /lora
	npm install telnet-stream @findoff/node-tuntap serialport
	mkdir /lora/src

Copy the contents of this directory within /lora/src

Now the configuration file, open config.json in notepad etc.

Below is an example of the file

{
        "repeatData":"disable",
        "repeatControl":"disable",
        "mode":"telnet",
        "serialSpeed":9600,
        "interfaceType":"tun",
        "interfaceName":"lora0",
        "mtu":600,
        "destination":"10.0.2.252",
        "destinationPort":"23",
        "address":"192.168.0.254",
        "mask":"255.255.255.0",
        "dedupHistoryData":0,
        "dedupHistoryControl":0,
        "waitPerByte":10,
        "waitToDiscard":30,
        "transmitWaitMax":50,
        "transmitWaitMin":10,
        "packetTimeout":300,
        "debugLevel":10
}


repeatData: disable/enable. This will tell it to repeat packages to the lora network that do not have a destination address of this node
repeatControl: disable/enable. This will tell it to repeat packages to the lora network that do not have a destination address of this node
mode: telnet/serial
serialSpeed: baudrate of the serial interface(only needed when using serial)
interfaceType: tun/tap type of interface to be used(currently only tun works)
interfaceName: name of the ethernet interface
mtu: mtu of the virtual NIC
destination: the destination address of the TNC, either IP for a TCP TNC or a serial port /dev/ttyusb0 etc
destinationPort: the telnet port(only neede when using telnet)
address: the IP address of the virtual nic on the LORA network
mask: mask of the LORA network
dedupHistoryData: how many data packets to hash to keep from retransmitting duplicate packets on the lora network. As more nodes have repeat enabled this will have to increase.
dedupHistoryControl: how many control packets to hash to keep from retransmitting duplicate packets on the lora network. As more nodes have repeat enabled this will have to increase.
waitPerByte: the inital wait per byte used to cause transmission waits to give time for data to make it through buffers and to the application. This is in milliseconds.
waitToDiscard: this prevents skewing of the waitPerByte average. Any dynamic value of waitPerByte that is greater than this number is discarded.
transmitWaitMax: The maximum random time to add to to the transmit wait timer. This helps prevent collisions so that everyones wait timer doesn't clear at once. This is in milliseconds
transmitWaitMin: The mininum random time to add to to the transmit wait timer. This helps prevent collisions so that everyones wait timer doesn't clear at once. This is in milliseconds
packetTimeout: The interval in which packets that have not been rebuilt are removed from the buffer. This is in seconds.
debugLevel: the debugging(log) level. Higher the number the more verbose.


FINALLY

Add the follow to end of crontab if you want it to startup at boot and watchdog it. use command crontab -e

* * * * * sh /lora/src/crontask


To configure hotspot and forward IRC(Copy and paste for RaspberryPi)

systemctl unmask hostapd
systemctl enable hostapd
rfkill unblock wlan

Add the following to the end of /etc/dhcpd.conf

	interface wlan0
		static ip_address=192.168.1.254/24
		nohook wpa_supplicant

Edit /etc/sysctl.conf and uncomment net.ipv4.ip_forward=1

Edit /etc/dnsmasq.conf and add the following

	interface=wlan0
	dhcp-range=192.168.1.1,192.168.1.20,255.255.255.0,24h
	domain=wlan
	address=/gw.wlan/192.168.1.254

Edit /etc/hostapd/hostapd.conf and add the following

	country_code=US
	interface=wlan0
	ssid=lora
	hw_mode=g
	channel=7
	macaddr_acl=0
	auth_algs=1
	ignore_broadcast_ssid=0
	wpa=2
	wpa_passphrase=somethingSafe
	wpa_key_mgmt=WPA-PSK
	wpa_pairwise=TKIP
	rsn_pairwise=CCMP

Firewall configuration

iptables -A FORWARD -d 192.168.0.254/32 -p tcp -m tcp --dport 6667 -j ACCEPT
iptables -A FORWARD -i lora0 -o lora0 -j DROP
iptables -t nat -A PREROUTING -i wlan0 -p tcp -m tcp --dport 6667 -j DNAT --to-destination 192.168.0.254:6667
iptables -t nat -A POSTROUTING -s 192.168.1.0/24 -d 192.168.0.254/32 -o lora0 -j MASQUERADE
iptables-save > /etc/iptables/rules.v4
