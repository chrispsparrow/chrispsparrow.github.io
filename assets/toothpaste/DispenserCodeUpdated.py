from machine import Pin, PWM
import time

#pinouts
BUTTON1pin = 14   # settings button
BUTTON2pin = 15   # start button

STBYpin = 16
PWMApin = 17
AIN1pin = 18
AIN2pin = 19

#fixed variable setup
ChildDuration = .25 #seconds
AdultDuration = .5 #seconds

DebounceMs = 25 #for button to avoid multiple presses when pressed
DoubleClickMs = 600 #max time between two presses for a double click

PwmFreq = 1000 #signal switch off and on
MotorDuty = 65535 #max power

#button and motor driver setup
button1 = Pin(BUTTON1pin, Pin.IN, Pin.PULL_UP) #button1 changes from adult to child setting
button2 = Pin(BUTTON2pin, Pin.IN, Pin.PULL_UP) #button2 starts the motor

stby = Pin(STBYpin, Pin.OUT) #on off pin
ain1 = Pin(AIN1pin, Pin.OUT) #rotational direction
ain2 = Pin(AIN2pin, Pin.OUT) #rotational direction

pwma = PWM(Pin(PWMApin))
pwma.freq(PwmFreq)
pwma.duty_u16(0) #starts motor off

stby.value(1) #enables driver

#variables
TimeSetting = AdultDuration #starts at adult be default
MotorForward = True #starts motor in forward direction

#Setup buttons for main loop 
b1StableState = button1.value() #value used after debounce
b1LastRaw = b1StableState #if signal change
b1LastChange = time.ticks_ms() #how long since last change - used for debounce 

b2StableState = button2.value()
b2LastRaw = b2StableState
b2LastChange = time.ticks_ms()

b1WaitingSecondClick = False #tracks if first click happened and waiting for second
b1FirstClickTime = 0 #stores time of first click

#motor setup
def motor_stop():
    pwma.duty_u16(0) #sets power to 0
    ain1.value(0) #no direction
    ain2.value(0) #no direction

def motor_forward(durationSeconds):
    if MotorForward:
        print("Motor forward for", durationSeconds, "second(s)")
        ain1.value(1) #in this direction
        ain2.value(0) #and not in this direction
    else:
        print("Motor reverse for", durationSeconds, "second(s)")
        ain1.value(0) #in this direction
        ain2.value(1) #and not in this direction

    pwma.duty_u16(MotorDuty) #max power defined above
    time.sleep(durationSeconds)
    motor_stop()
    print("Motor stopped")

#button
def toggle_setting():
    global TimeSetting

    if TimeSetting == AdultDuration:
        TimeSetting = ChildDuration
        print("Mode changed to: CHILD")
        print("TimeSetting =", TimeSetting, "second(s)")
    else:
        TimeSetting = AdultDuration
        print("Mode changed to: ADULT")
        print("TimeSetting =", TimeSetting, "second(s)")

def toggle_direction():
    global MotorForward

    if MotorForward:
        MotorForward = False
        print("Direction changed to: REVERSE")
    else:
        MotorForward = True
        print("Direction changed to: FORWARD")

def start_mechanism():
    print("Start button pressed")
    print("Running motor for", TimeSetting, "second(s)")
    motor_forward(TimeSetting)



#loop
print("Ready")
print("Starting mode = ADULT")
print("TimeSetting =", TimeSetting)
print("Starting direction = FORWARD")

while True:
    now = time.ticks_ms() #tracks time while program runs for button debounce

    #button1 code
    b1Raw = button1.value()

    if b1Raw != b1LastRaw: #if pressed
        b1LastRaw = b1Raw #record that change in state
        b1LastChange = now #record the time it happened for debounce

    if time.ticks_diff(now, b1LastChange) >= DebounceMs: #from now since the last signal hang has it been more than 25ms?
        if b1StableState != b1Raw: #if value is different from before
            b1StableState = b1Raw #update this state 

            # Button 1 just pressed
            if b1StableState == 0: #if pressed
                if b1WaitingSecondClick:
                    if time.ticks_diff(now, b1FirstClickTime) <= DoubleClickMs:
                        b1WaitingSecondClick = False
                        toggle_direction()
                    else:
                        b1FirstClickTime = now
                        b1WaitingSecondClick = True
                else:
                    b1FirstClickTime = now
                    b1WaitingSecondClick = True

    if b1WaitingSecondClick:
        if time.ticks_diff(now, b1FirstClickTime) > DoubleClickMs:
            b1WaitingSecondClick = False
            toggle_setting() #defined above 

    #button 2 code
    b2Raw = button2.value()

    if b2Raw != b2LastRaw:
        b2LastRaw = b2Raw
        b2LastChange = now

    if time.ticks_diff(now, b2LastChange) >= DebounceMs:
        if b2StableState != b2Raw:
            b2StableState = b2Raw

            # Button 2 just pressed
            if b2StableState == 0: #if pressed
                start_mechanism() #defined above

    time.sleep_ms(10) 