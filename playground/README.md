# SO100/SO101 Playground

A browser-based application for simulating and controlling SO-100 and SO-101 robotic arms. This platform allows users to visualize, interact with, and control both virtual and real robot arms in real time.

## Features

- 3D visualization of SO-100 and SO-101 robot arms
- Real robot control via Web Serial API (Feetech SCS servos, IDs 1-6)
- Simultaneous control of virtual and real robots
- Keyboard and gamepad input support
- Per-servo direction inversion toggles (with persistent settings)
- Adjustable movement speed
- Visual feedback for joint/servo status and limits
- Help tooltips for controls and servo status

## Controls

### Keyboard Controls
- **Rotation**: 1 / Q
- **Pitch**: 2 / W
- **Elbow**: 3 / E
- **Wrist Pitch**: 4 / R
- **Wrist Roll**: 5 / T
- **Jaw**: 6 / Y


### Gamepad Controls
- **Rotation**: Face Right (button 1) / Face Left (button 2)
- **Pitch**: Face Top (button 3) / Face Bottom (button 0)
- **Elbow**: R2 (button 7) / R1 (button 5)
- **Wrist Pitch**: D-Up (button 12) / D-Down (button 13)
- **Wrist Roll**: D-Right (button 15) / D-Left (button 14)
- **Jaw**: L2 (button 6) / L1 (button 4)
- Real-time button highlighting and support for PlayStation, Xbox, and Nintendo layouts

## Real Robot Control

- Connect to a real robot using the "Connect Real Robot" button (requires Chrome/Edge with Web Serial API)
- Keyboard and gamepad controls move both the virtual and real robot simultaneously
- Movement speed is adjustable via the speed slider
- Each servo's direction can be inverted using the toggle buttons next to their status indicators
- Servo status (idle, pending, success, error, warning) is displayed for each joint

### How It Works
- On connection, the app reads the current positions of all servos
- All commands are relative to the current position, ensuring correct behavior regardless of initial pose
- Direction toggles allow you to invert individual servo movements if needed
- Status indicators and alerts provide feedback for joint limits and servo errors

## Requirements
- Chrome or Edge browser with Web Serial API support
- USB-to-Serial adapter connected to the robot's servo bus
- Servo IDs configured from 1 to 6 (matching the joint numbers)

## Usage
1. Open the application in a supported browser
2. Click "Connect Real Robot" to connect to hardware (optional)
3. Use keyboard or gamepad controls to move the robot
4. Adjust speed and direction toggles as needed

Note: ensure your physical robot's position matches the virtual robot's position before connecting
