const winston = require('winston');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(message => {
            const getLevel = message => `${message.exception ? 'UNCAUGHT EXCEPTION' : message.level.toUpperCase()}`;
            const getMessage = message => `${message.stack ? message.stack : message.message}${message.cause ? '\nCaused by ' + getMessage(message.cause) : ''}`;
            return `${message.timestamp} | ${getLevel(message)} | ${getMessage(message)}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({
            filename: `${__dirname}/app.log`,
            maxsize: 1000000
        })
    ],
    exceptionHandlers: [
        new winston.transports.Console(),
        new winston.transports.File({
            filename: `${__dirname}/app.log`,
            maxsize: 1000000
        })
    ]
});

logger.info('=== DOOR SENSOR INITIALIZATION START ===');

logger.debug('Loading dependencies...');

const fs = require('fs');
const mqtt = require('mqtt');
const onoff = require('onoff');
const rxjs = require('rxjs');

logger.debug('Loading dependencies completed.');

logger.debug('Preparing output pin driver definition...');

const createOutputPinDriver = pinNumber => {
    const pin = new onoff.Gpio(pinNumber, 'low');
    
    let pulseTimeout = null;
    let pulseInterval = null;
    let pulseCount = null;
    
    let pulseTimeoutId = null;
    let pulseIntervalId = null;
    let remainingPulseCount = null;
    
    const setOn = () => {
        pulseTimeout = null;
        pulseInterval = null;
        pulseCount = null;
        
        clearTimeout(pulseTimeoutId);
        clearInterval(pulseIntervalId);
        pin.write(1);
    };
    
    const setOff = () => {
        pulseTimeout = null;
        pulseInterval = null;
        pulseCount = null;
        
        clearTimeout(pulseTimeoutId);
        clearInterval(pulseIntervalId);
        pin.write(0);
    };
    
    const pulse = (newPulseTimeout, newPulseInterval, newPulseCount) => {
        newPulseTimeout = newPulseTimeout || 50;
        newPulseInterval = newPulseInterval || 150;
        newPulseCount = newPulseCount || 1;
        
        if (pulseTimeout === newPulseTimeout && pulseInterval === newPulseInterval && pulseCount === newPulseCount && pulseCount === -1) {
            return;
        }
        
        pulseTimeout = newPulseTimeout;
        pulseInterval = newPulseInterval;
        pulseCount = newPulseCount;
        
        clearTimeout(pulseTimeoutId);
        clearInterval(pulseIntervalId);
        remainingPulseCount = pulseCount;
        
        const pulseOnceOrDie = () => {
            if (remainingPulseCount) {
                remainingPulseCount = remainingPulseCount === -1 ? -1 : remainingPulseCount - 1;
                pin.write(1);
                pulseTimeoutId = setTimeout(() => pin.write(0), pulseTimeout);
            } else {
                pulseTimeout = null;
                pulseInterval = null;
                pulseCount = null;
                
                clearInterval(pulseIntervalId);
            }
        };
        
        pulseOnceOrDie();
        pulseIntervalId = setInterval(pulseOnceOrDie, pulseInterval);
    };
    
    return {
        setOn: () => setOn(),
        setOff: () => setOff(),
        pulse: (pulseTimeout, pulseInterval, pulseCount) => pulse(pulseTimeout, pulseInterval, pulseCount)
    };
};

logger.debug('Preparing output pin driver definition completed.');

logger.debug('Creating output pin drivers...');

const notificationTriggerOffLedPinDriver = createOutputPinDriver(process.env.APP_NOTIFICATION_TRIGGER_OFF_LED_PIN);
const notificationTriggerOnLedPinDriver = createOutputPinDriver(process.env.APP_NOTIFICATION_TRIGGER_ON_LED_PIN);
const sirenTriggerOffLedPinDriver = createOutputPinDriver(process.env.APP_SIREN_TRIGGER_OFF_LED_PIN);
const sirenTriggerOnLedPinDriver = createOutputPinDriver(process.env.APP_SIREN_TRIGGER_ON_LED_PIN);
const sirenLedPinDriver = createOutputPinDriver(process.env.APP_SIREN_LED_PIN);
const buzzerPinDriver = createOutputPinDriver(process.env.APP_BUZZER_PIN);
const sirenPinDriver = createOutputPinDriver(process.env.APP_SIREN_PIN);

logger.debug('Creating output pin drivers completed.');

logger.debug('Preparing input pin driver definition...');

const createInputPinDriver = (pinNumber, throttleTime) => {
    const pin = new onoff.Gpio(pinNumber, 'in', 'both');
    const pinRising$ = new rxjs.BehaviorSubject(1);
    const pinFalling$ = new rxjs.BehaviorSubject(0);
    pin.watch((e, value) => {
        if (e) {
            throw e;
        }
        if (value) {
            pinRising$.next(value);
        } else {
            pinFalling$.next(value);
        }
    });
    const throttledPinRising$ = pinRising$.pipe(rxjs.skip(1), rxjs.throttleTime(throttleTime || 100));
    const throttledPinFalling$ = pinFalling$.pipe(rxjs.skip(1), rxjs.throttleTime(throttleTime || 100));
    
    return {
        get: () => pin.readSync(),
        watchRising: callback => throttledPinRising$.subscribe(callback || (value => {})),
        watchFalling: callback => throttledPinFalling$.subscribe(callback || (value => {}))
    };
};

logger.debug('Preparing input pin driver definition completed.');

logger.debug('Creating input pin drivers...');

const doorSensorPinDriver = createInputPinDriver(process.env.APP_DOOR_SENSOR_PIN, 100);
const notificationTriggerOffBtnPinDriver = createInputPinDriver(process.env.APP_NOTIFICATION_TRIGGER_OFF_BTN_PIN, 100);
const notificationTriggerOnBtnPinDriver = createInputPinDriver(process.env.APP_NOTIFICATION_TRIGGER_ON_BTN_PIN, 100);
const sirenTriggerOffBtnPinDriver = createInputPinDriver(process.env.APP_SIREN_TRIGGER_OFF_BTN_PIN, 100);
const sirenTriggerOnBtnPinDriver = createInputPinDriver(process.env.APP_SIREN_TRIGGER_ON_BTN_PIN, 100);
const sirenBtnPinDriver = createInputPinDriver(process.env.APP_SIREN_BTN_PIN, 100);

logger.debug('Creating input pin drivers completed.');

logger.debug('Preparing MQTT driver definition...');

const createMqttDriver = () => {
    let connection = null;
    
    const connect = () => {
        if (process.env.APP_MQTT_ENABLED === 'true') {
            let options = {
                protocol: process.env.APP_MQTT_PROTOCOL,
                host: process.env.APP_MQTT_HOST,
                port: process.env.APP_MQTT_PORT,
                username: process.env.APP_MQTT_USERNAME,
                password: Buffer.from(process.env.APP_MQTT_PASSWORD, 'base64').toString('utf8')
            };
            if (process.env.APP_MQTT_PROTOCOL === 'mqtts') {
                options = {
                    ...options,
                    ca: fs.readFileSync(`${__dirname}/${process.env.APP_MQTT_CA_FILENAME}`),
                    cert: fs.readFileSync(`${__dirname}/${process.env.APP_MQTT_CERT_FILENAME}`),
                    key: fs.readFileSync(`${__dirname}/${process.env.APP_MQTT_KEY_FILENAME}`)
                };
            }
            connection = mqtt.connect(options);
        } else {
            logger.warn('MQTT is disabled.');
        }
    };
    
    const publish = (topic, message, qos, retain) => {
        if (connection !== null) {
            connection.publish(
                `${process.env.APP_MQTT_TOPIC_SITE}/${process.env.APP_MQTT_TOPIC_DEVICE_TYPE}/${process.env.APP_MQTT_TOPIC_DEVICE_NAME}/${topic}`,
                message || '{}',
                { qos: qos || 0, retain: retain || false },
                e => {
                    if (e) {
                        logger.error(e);
                    }
                }
            );
        } else {
            logger.debug('MQTT is disabled, no data sent.');
        }
    };
    
    const subscribe = (topic, qos) => {
        if (connection !== null) {
            connection.subscribe(
                `${process.env.APP_MQTT_TOPIC_SITE}/${process.env.APP_MQTT_TOPIC_DEVICE_TYPE}/${process.env.APP_MQTT_TOPIC_DEVICE_NAME}/${topic}`,
                { qos: qos || 0 },
                e => {
                    if (e) {
                        logger.error(e);
                    }
                }
            );
        } else {
            logger.debug('MQTT is disabled, no subscription made.');
        }
    };
    
    const onConnect = callback => {
        if (connection !== null) {
            connection.on('connect', callback);
        }
    };
    
    const onClose = callback => {
        if (connection !== null) {
            connection.on('close', callback);
        }
    };
    
    const onError = callback => {
        if (connection !== null) {
            connection.on('error', callback);
        }
    };
    
    const onMessage = callback => {
        if (connection !== null) {
            connection.on('message', (topic, message) => {
                callback(
                    topic.substr(`${process.env.APP_MQTT_TOPIC_SITE}/${process.env.APP_MQTT_TOPIC_DEVICE_TYPE}/${process.env.APP_MQTT_TOPIC_DEVICE_NAME}/`.length),
                    message
                );
            });
        }
    };
    
    return {
        connect: () => connect(),
        publish: (topic, message, qos, retain) => publish(topic, message, qos, retain),
        subscribe: (topic, qos) => subscribe(topic, qos),
        onConnect: callback => onConnect(callback),
        onClose: callback => onClose(callback),
        onError: callback => onError(callback),
        onMessage: callback => onMessage(callback)
    };
};

logger.debug('Preparing MQTT driver definition completed.');

logger.debug('Creating MQTT driver...');

const mqttDriver = createMqttDriver();

logger.debug('Creating MQTT driver completed.');

logger.debug('Connecting MQTT server...');

mqttDriver.connect();

logger.debug('Connecting MQTT server completed.');

logger.debug('Preparing state driver definition...');

const createStateDriver = () => {
    let data = {
        notificationTrigger: 'OFF',
        sirenTrigger: 'OFF',
        siren: 'OFF',
        delayedSirenTriggerOn: 'OFF',
        delayedSirenOn: 'OFF',
        doorState: 'CLOSE'
    };
    
    const write = callback => {
        fs.writeFile(`${__dirname}/state.json`, JSON.stringify({
            notificationTrigger: data.notificationTrigger,
            sirenTrigger: data.sirenTrigger
        }, null, '    '), e => {
            if (e) {
                logger.error(e);
            } else {
                (callback || (() => {}))();
            }
        });
    };
    
    const read = () => {
        if (!fs.existsSync(`${__dirname}/state.json`)) {
            write(() => logger.warn('State file does not exist. New state file created.'));
            mqttDriver.publish('state', JSON.stringify({ ...data, timestamp: Date.now() }, null, '    '), 2, true);
        } else {
            try {
                data = { ...data, ...JSON.parse(fs.readFileSync(`${__dirname}/state.json`, 'utf8')) };
                data = { ...data, doorState: doorSensorPinDriver.get() ? 'CLOSE' : 'OPEN' };
            } catch (e) {
                write(() => logger.warn('Invalid state file content. New state file created.'));
                mqttDriver.publish('state', JSON.stringify({ ...data, timestamp: Date.now() }, null, '    '), 2, true);
            }
        }
    };
    
    const apply = (buzzerPulseTimeout, buzzerPulseInterval, buzzerPulseCount) => {
        if (data.notificationTrigger === 'OFF') {
            notificationTriggerOffLedPinDriver.setOn();
        } else {
            notificationTriggerOffLedPinDriver.setOff();
        }
        
        if (data.notificationTrigger === 'ON') {
            notificationTriggerOnLedPinDriver.setOn();
        } else {
            notificationTriggerOnLedPinDriver.setOff();
        }
        
        if (data.sirenTrigger === 'OFF') {
            sirenTriggerOffLedPinDriver.setOn();
        } else {
            sirenTriggerOffLedPinDriver.setOff();
        }
        
        if (data.sirenTrigger === 'ON') {
            sirenTriggerOnLedPinDriver.setOn();
        } else if (data.delayedSirenTriggerOn === 'ON') {
            sirenTriggerOnLedPinDriver.pulse(250, 500, -1);
        } else {
            sirenTriggerOnLedPinDriver.setOff();
        }
        
        if (data.siren === 'ON') {
            sirenLedPinDriver.setOn();
        } else if (data.delayedSirenOn === 'ON') {
            sirenLedPinDriver.pulse(250, 500, -1);
        } else {
            sirenLedPinDriver.setOff();
        }
        
        if (data.delayedSirenTriggerOn === 'ON') {
            buzzerPinDriver.pulse(25, 1000, -1);
        } else if (buzzerPulseCount) {
            buzzerPinDriver.pulse(buzzerPulseTimeout, buzzerPulseInterval, buzzerPulseCount);
        } else {
            buzzerPinDriver.setOff();
        }
        
        if (data.siren === 'ON') {
            sirenPinDriver.setOn();
        } else {
            sirenPinDriver.setOff();
        }
    };
    
    const getAll = () => {
        return data;
    };
    
    const get = prop => {
        return data[prop];
    };
    
    let delayedSirenTriggerOnTimeoutId = null;
    let delayedSirenOnTimeoutId = null;
    
    const set = (newData, buzzerPulseTimeout, buzzerPulseInterval, buzzerPulseCount) => {
        newData = newData || {};
        data = { ...data, ...newData };
        if (newData.delayedSirenTriggerOn === 'ON') {
            clearTimeout(delayedSirenTriggerOnTimeoutId);
            delayedSirenTriggerOnTimeoutId = setTimeout(() => {
                set({ sirenTrigger: 'ON', delayedSirenTriggerOn: 'OFF' }, 25, 150, 3);
            }, process.env.APP_SIREN_TRIGGER_ON_DELAY * 1000);
        }
        if (newData.delayedSirenTriggerOn === 'OFF') {
            clearTimeout(delayedSirenTriggerOnTimeoutId);
        }
        if (newData.delayedSirenOn === 'ON') {
            clearTimeout(delayedSirenOnTimeoutId);
            delayedSirenOnTimeoutId = setTimeout(() => {
                set({ siren: 'ON', delayedSirenOn: 'OFF' });
            }, process.env.APP_SIREN_ON_DELAY * 1000);
        }
        if (newData.delayedSirenOn === 'OFF') {
            clearTimeout(delayedSirenOnTimeoutId);
        }
        write();
        mqttDriver.publish('state', JSON.stringify({ ...data, timestamp: Date.now() }, null, '    '), 2, true);
        apply(buzzerPulseTimeout, buzzerPulseInterval, buzzerPulseCount);
    };
    
    return {
        read: () => read(),
        apply: (buzzerPulseTimeout, buzzerPulseInterval, buzzerPulseCount) => apply(buzzerPulseTimeout, buzzerPulseInterval, buzzerPulseCount),
        getAll: () => getAll(),
        get: prop => get(prop),
        set: (newData, buzzerPulseTimeout, buzzerPulseInterval, buzzerPulseCount) => set(newData, buzzerPulseTimeout, buzzerPulseInterval, buzzerPulseCount)
    };
};

logger.debug('Preparing state driver definition completed.');

logger.debug('Creating state driver...');

const stateDriver = createStateDriver();

logger.debug('Creating state driver completed.');

logger.debug('Initiating state...');

stateDriver.read();
stateDriver.apply();

logger.debug('Initiating state completed.');

logger.debug('Creating input pin listeners...');

doorSensorPinDriver.watchRising(value => {
    stateDriver.set({ doorState: 'CLOSE' });
});

doorSensorPinDriver.watchFalling(value => {
    let newData = { doorState: 'OPEN' };
    if (stateDriver.get('sirenTrigger') === 'ON' && stateDriver.get('delayedSirenOn') === 'OFF' && stateDriver.get('siren') === 'OFF') {
        newData = { ...newData, delayedSirenOn: 'ON' };
    }
    stateDriver.set(newData);
    if (stateDriver.get('notificationTrigger') === 'ON') {
        mqttDriver.publish('door-open', '{}', 2);
    }
});

notificationTriggerOffBtnPinDriver.watchRising(value => {
    if (stateDriver.get('notificationTrigger') === 'ON') {
        stateDriver.set({ notificationTrigger: 'OFF' }, 25, 150, 1);
    }
});

notificationTriggerOnBtnPinDriver.watchRising(value => {
    if (stateDriver.get('notificationTrigger') === 'OFF') {
        stateDriver.set({ notificationTrigger: 'ON' }, 25, 150, 1);
    }
});

sirenTriggerOffBtnPinDriver.watchRising(value => {
    if (stateDriver.get('sirenTrigger') === 'ON' || stateDriver.get('delayedSirenTriggerOn') === 'ON') {
        stateDriver.set({ sirenTrigger: 'OFF', delayedSirenTriggerOn: 'OFF' }, 25, 150, 1);
    }
});

sirenTriggerOnBtnPinDriver.watchRising(value => {
    if (stateDriver.get('sirenTrigger') === 'OFF' && stateDriver.get('delayedSirenTriggerOn') === 'OFF') {
        stateDriver.set({ delayedSirenTriggerOn: 'ON' });
    }
});

sirenBtnPinDriver.watchRising(value => {
    if (stateDriver.get('delayedSirenOn') === 'ON' || stateDriver.get('siren') === 'ON') {
        stateDriver.set({ delayedSirenOn: 'OFF', siren: 'OFF' }, 25, 150, 1);
    }
});

logger.debug('Creating input pin listeners completed.');

logger.debug('Creating MQTT listeners...');

let connectionState = 'unknown';

const setConnectionState = newConnectionState => {
    connectionState = newConnectionState;
    logger.info(`MQTT client ${newConnectionState}.`);
    if (['connected', 'reconnected'].includes(newConnectionState)) {
        mqttDriver.publish('state', JSON.stringify({ ...stateDriver.getAll(), timestamp: Date.now() } , null, '    '), 2, true);
    }
};

mqttDriver.onConnect(() => {
    if (['unknown', 'unconnected'].includes(connectionState)) {
        setConnectionState('connected');
    } else if (connectionState === 'disconnected') {
        setConnectionState('reconnected');
    }
});

mqttDriver.onClose(() => {
    if (connectionState === 'unknown') {
        setConnectionState('unconnected');
    } else if (['connected', 'reconnected'].includes(connectionState)) {
        setConnectionState('disconnected');
    }
});

mqttDriver.subscribe('#', 2);
mqttDriver.onMessage((topic, message) => {
    switch (topic) {
        case 'notification-trigger-off':
            if (stateDriver.get('notificationTrigger') === 'ON') {
                stateDriver.set({ notificationTrigger: 'OFF' }, 25, 150, 1);
            }
            break;
        case 'notification-trigger-on':
            if (stateDriver.get('notificationTrigger') === 'OFF') {
                stateDriver.set({ notificationTrigger: 'ON' }, 25, 150, 1);
            }
            break;
        case 'siren-trigger-off':
            if (stateDriver.get('sirenTrigger') === 'ON' || stateDriver.get('delayedSirenTriggerOn') === 'ON') {
                stateDriver.set({ sirenTrigger: 'OFF', delayedSirenTriggerOn: 'OFF' }, 25, 150, 1);
            }
            break;
        case 'siren-trigger-on':
            if (stateDriver.get('sirenTrigger') === 'OFF') {
                stateDriver.set({ sirenTrigger: 'ON', delayedSirenTriggerOn: 'OFF' }, 25, 150, 3);
            }
            break;
        case 'siren-off':
            if (stateDriver.get('delayedSirenOn') === 'ON' || stateDriver.get('siren') === 'ON') {
                stateDriver.set({ delayedSirenOn: 'OFF', siren: 'OFF' }, 25, 150, 1);
            }
            break;
        default:
    }
});

logger.debug('Creating MQTT listeners completed.');

logger.debug('Creating door sensor state repeater...');

setInterval(() => {
    stateDriver.set({ doorState: doorSensorPinDriver.get() ? 'CLOSE' : 'OPEN' });
}, 15000);

logger.debug('Creating door sensor state repeater completed.');

logger.info('=== DOOR SENSOR INITIALIZATION COMPLETED ===');
