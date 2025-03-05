# Door sensor

This is the documentation of Door sensor, an application that enables to create a door sensor from a Raspberry Pi. This door sensor can work offline or can be connected to an MQTT broker!

The following steps describe the installation of Door sensor on Raspberry Pi.

A hardware example will be added later :-)

## Install the prerequisite software

### Install Node.js

1. Connect to the device through SSH.
2. Switch to `root` through `sudo su`.
3. Install Node.js and npm:
```
curl -sL https://deb.nodesource.com/setup_21.x | sudo bash -
apt update
apt upgrade
apt install nodejs
```

## Install the app

### Prepare the UNIX user

1. Connect to the device through SSH.
2. Switch to `root` through `sudo su`.
3. Create the new user `door-sensor`:
```
adduser door-sensor
```
4. Add user `door-sensor` to group `gpio`:
```
usermod -a -G gpio door-sensor
```

### Prepare the file system

1. Create the `/var/door-sensor` directory:
```
mkdir /var/door-sensor
chown door-sensor:door-sensor /var/door-sensor
```
2. Copy the content of this folder to the directory `/var/door-sensor`.

### Customize `door-sensor.service`

1. Set the environment variable `APP_MQTT_ENABLED` to `true` to enable the communication with an MQTT broker.
2. Depending on the configuration of MQTT broker, set `APP_MQTT_PROTOCOL` to `mqtt` or `mqtts`. In case of `mqtts`, it's necessary to put the certificate files into the directory `/var/door-sensor` and don't forget to set their filenames into `door-sensor.service`:
```
APP_MQTT_CA_FILENAME=rootCA.crt
APP_MQTT_CERT_FILENAME=mysite.crt
APP_MQTT_KEY_FILENAME=mysite.key
```
3. Set the MQTT broker password encoded in base64.
4. Depending on which pins the buttons, door sensor, signal diodes, beeper and siren are connected to, adjust the pin numbers in `door-sensor.service`.

### Install NPM modules and start the app

1. Install npm modules:
```
su - door-sensor
cd /var/door-sensor
npm install
exit
```
2. Enable and start the `door-sensor` service:
```
systemctl enable /var/door-sensor/door-sensor.service
systemctl start door-sensor
```

### Usage

After the connection to the MQTT server, the door sensor sends its state every 15 seconds and after the state change using the `door-sensor-topic/state` topic.

The door sensor state contains the following data:
- `notificationTrigger` (ON/OFF)
- `sirenTrigger` (ON/OFF)
- `siren`: (ON/OFF)
- `delayedSirenTriggerOn`: (ON/OFF)
- `delayedSirenOn`: (ON/OFF)
- `doorState`: (OPEN/CLOSE)
- `timestamp`: (Unix time in seconds)

You can enable the notification trigger using the `door-sensor-topic/notification-trigger-on` topic.

You can disable the notification trigger using the `door-sensor-topic/notification-trigger-off` topic.

You can enable the siren trigger using the `door-sensor-topic/siren-trigger-on` topic.

You can disable the siren trigger using the `door-sensor-topic/siren-trigger-off` topic.

You can switch off the siren using the `door-sensor-topic/siren-off` topic.

## Authors

- [**Eli Nucknack**](mailto:eli.nucknack@gmail.com)
