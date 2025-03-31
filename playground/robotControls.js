import { MathUtils } from 'three';
// Import feetech SDK for real servo control
import { 
  PortHandler, 
  PacketHandler
} from './feetech/scsservo_sdk.mjs';
// Import constants from our constants file
import {
  COMM_SUCCESS,
  ADDR_SCS_TORQUE_ENABLE,
  ADDR_SCS_GOAL_ACC,
  ADDR_SCS_GOAL_POSITION,
  ADDR_SCS_GOAL_SPEED,
  ADDR_SCS_PRESENT_POSITION,
  ERRBIT_VOLTAGE,
  ERRBIT_ANGLE,
  ERRBIT_OVERHEAT,
  ERRBIT_OVERELE,
  ERRBIT_OVERLOAD
} from './feetech/scsservo_constants.mjs';
// Import Joy-Con WebHID library
import {
  connectJoyCon,
  connectedJoyCons,
  JoyConLeft,
  JoyConRight,
  GeneralController,
} from 'joy-con-webhid';

// Servo control variables
let portHandler = null;
let packetHandler = null;
let isConnectedToRealRobot = false;

// 存储真实舵机的当前位置
let servoCurrentPositions = {
  1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0,
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0,
};

// 存储真实舵机的最后一个安全位置
let servoLastSafePositions = {
  1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0,
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0,
};

// 舵机通信状态
let servoCommStatus = {
  1: { status: 'idle', lastError: null },
  2: { status: 'idle', lastError: null },
  3: { status: 'idle', lastError: null },
  4: { status: 'idle', lastError: null },
  5: { status: 'idle', lastError: null },
  6: { status: 'idle', lastError: null },
  7: { status: 'idle', lastError: null },
  8: { status: 'idle', lastError: null },
  9: { status: 'idle', lastError: null },
  10: { status: 'idle', lastError: null },
  11: { status: 'idle', lastError: null },
  12: { status: 'idle', lastError: null },
  13: { status: 'idle', lastError: null },
  14: { status: 'idle', lastError: null },
  15: { status: 'idle', lastError: null }
};

// 命令队列系统，确保串口操作顺序执行
let commandQueue = [];
let isProcessingQueue = false;

// 记录轮子舵机的活动状态
const wheelActive = {
  13: false,
  14: false,
  15: false
};

// 添加一个工具函数来获取关节索引对应的舵机ID（如果使用keyMappings则不需要）
function getServoIdFromJointIndex(jointIndex) {
  return jointIndex + 1; // 简单映射关系，关节索引从0开始，舵机ID从1开始
}

/**
 * 添加舵机分组信息，方便批量操作
 */
const servoGroups = {
  leftArm: [1, 2, 3, 4, 5, 6],
  rightArm: [7, 8, 9, 10, 11, 12],
  wheels: [13, 14, 15],
  all: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
};

/**
 * 显示警告提醒
 * @param {string} type - 提醒类型 ('joint' 虚拟关节限位, 'servo' 真实舵机错误)
 * @param {string} message - 显示的消息
 * @param {number} duration - 显示持续时间(毫秒)，默认3秒
 */
function showAlert(type, message, duration = 3000) {
  const alertId = type === 'joint' ? 'jointLimitAlert' : 'servoLimitAlert';
  const alertElement = document.getElementById(alertId);
  
  if (alertElement) {
    // 设置消息并显示
    alertElement.textContent = message;
    alertElement.style.display = 'block';
    
    // 设置定时器，自动隐藏
    setTimeout(() => {
      alertElement.style.display = 'none';
    }, duration);
  }
}

/**
 * 添加命令到队列并执行
 * @param {Function} commandFn - 一个返回Promise的函数
 * @returns {Promise} 命令执行的Promise
 */
function queueCommand(commandFn) {
  return new Promise((resolve, reject) => {
    // 添加命令到队列
    commandQueue.push({
      execute: commandFn,
      resolve,
      reject
    });
    
    // 如果队列未在处理中，开始处理
    if (!isProcessingQueue) {
      processCommandQueue();
    }
  });
}

/**
 * 处理命令队列
 */
async function processCommandQueue() {
  if (commandQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }
  
  isProcessingQueue = true;
  const command = commandQueue.shift();
  
  try {
    // 在执行下一个命令前等待一小段时间
    await new Promise(resolve => setTimeout(resolve, 5));
    const result = await command.execute();
    command.resolve(result);
  } catch (error) {
    command.reject(error);
    console.error('Command execution error:', error);
  }
  
  // 继续处理队列中的下一个命令
  await processCommandQueue();
}

/**
 * 检查关节值是否在URDF定义的限制范围内
 * @param {Object} joint - 关节对象
 * @param {number} newValue - 新的关节值
 * @returns {boolean} 如果在限制范围内则返回true
 */
function isJointWithinLimits(joint, newValue) {
  // 如果关节类型是continuous或类型是fixed，则没有限制
  if (joint.jointType === 'continuous' || joint.jointType === 'fixed') {
    return true;
  }
  
  // 如果关节设置了ignoreLimits标志，也返回true
  if (joint.ignoreLimits) {
    return true;
  }
  
  // 检查关节值是否在上下限范围内
  // 注意：对于多自由度关节，需要检查每个值
  if (Array.isArray(newValue)) {
    // 对于多自由度关节如planar、floating等
    return true; // 这种情况较为复杂，需要根据实际情况处理
  } else {
    // 对于单自由度关节，如revolute或prismatic
    return newValue >= joint.limit.lower && newValue <= joint.limit.upper;
  }
}

/**
 * Core robot control functions that can be used by any input method (keyboard, joycon, etc.)
 */
export const robotControl = {
  /**
   * Control a single servo joint movement
   * @param {Object} robot - Robot object
   * @param {number} jointIndex - Joint index
   * @param {number} direction - Movement direction (-1 or 1)
   * @returns {Promise<boolean>} Whether operation was successful
   */
  controlJoint: async function(robot, jointIndex, direction) {
    // Get joint name from index
    const jointName = this.getJointNameByIndex(robot, jointIndex);
    if (!jointName) {
      console.warn(`Invalid joint index: ${jointIndex}`);
      return false;
    }

    // Get current joint value
    const currentValue = robot.joints[jointName].angle;
    
    // Calculate new joint value
    const newValue = currentValue + direction * stepSize;
    
    // Get servo ID (typically jointIndex + 1, but could be different)
    const servoId = getServoIdFromJointIndex(jointIndex);
    
    // Check if exceeding joint limits
    if (!isJointWithinLimits(robot.joints[jointName], newValue)) {
      console.warn(`Joint ${jointName} would exceed its limits. Movement prevented.`);
      // Show virtual joint limit alert
      showAlert('joint', `Joint ${jointName} has reached its limit!`);
      return false;
    }
    
    // If not connected to real robot, just update virtual joint
    if (!isConnectedToRealRobot) {
      robot.joints[jointName].setJointValue(newValue);
      return true;
    }
    
    // Handle real robot control
    const isWheelServo = servoId >= 13 && servoId <= 15;
    
    if (isWheelServo) {
      // Wheel servos use speed control
      const speedFactor = 500; // Base speed value
      const wheelSpeed = direction * speedFactor;
      
      console.log(`Setting wheel servo ${servoId} speed to ${wheelSpeed}`);
      
      try {
        await writeWheelSpeed(servoId, wheelSpeed);
        robot.joints[jointName].setJointValue(newValue);
        servoCommStatus[servoId].status = 'success';
        updateServoStatusUI();
        return true;
      } catch (error) {
        console.error(`Error controlling wheel servo ${servoId}:`, error);
        servoCommStatus[servoId].status = 'error';
        servoCommStatus[servoId].lastError = error.message || 'Communication error';
        updateServoStatusUI();
        showAlert('servo', `Wheel servo ${servoId} error: ${error.message || 'Communication failed'}`);
        return false;
      }
    } else {
      // Non-wheel servos use position control
      // Calculate servo position change in servo steps
      const stepChange = Math.round((direction * stepSize) * (4096 / (2 * Math.PI)));
      
      // Calculate new position value
      let newPosition = (servoCurrentPositions[servoId] + stepChange) % 4096;
      
      // Store current position (virtual servo not updated yet)
      const prevPosition = servoCurrentPositions[servoId];
      // Update current position record
      servoCurrentPositions[servoId] = newPosition;
      
      // Update servo status to pending
      servoCommStatus[servoId].status = 'pending';
      updateServoStatusUI();
      
      try {
        // Use queue system to control servo, prevent concurrent access
        await writeServoPosition(servoId, newPosition);
        // Update virtual joint
        robot.joints[jointName].setJointValue(newValue);
        // Update last safe position
        servoLastSafePositions[servoId] = newPosition;
        
        // Update servo status to success
        servoCommStatus[servoId].status = 'success';
        updateServoStatusUI();
        return true;
      } catch (error) {
        // Servo control failed, don't update virtual joint, restore current position
        servoCurrentPositions[servoId] = prevPosition;
        console.error(`Error controlling servo ${servoId}:`, error);
        servoCommStatus[servoId].status = 'error';
        servoCommStatus[servoId].lastError = error.message || 'Communication error';
        updateServoStatusUI();
        
        // Show servo error alert
        showAlert('servo', `Servo ${servoId} error: ${error.message || 'Communication failed'}`);
        return false;
      }
    }
  },

  /**
   * Control a servo with specific speed or magnitude (for analog inputs)
   * @param {Object} robot - Robot object
   * @param {number} jointIndex - Joint index
   * @param {number} direction - Direction (-1 or 1)
   * @param {number} magnitude - Magnitude (0.0-1.0) to scale the movement
   * @returns {Promise<boolean>} Whether operation was successful
   */
  controlJointWithMagnitude: async function(robot, jointIndex, direction, magnitude) {
    // Get joint name from index
    const jointName = this.getJointNameByIndex(robot, jointIndex);
    if (!jointName) return false;
    
    // Store original step size
    const originalStepSize = stepSize;
    
    try {
      // Scale stepSize by magnitude temporarily
      const scaledStepSize = originalStepSize * magnitude;
      stepSize = scaledStepSize;
      
      // Use the refactored controlJoint function
      return await this.controlJoint(robot, jointIndex, direction);
    } finally {
      // Restore original stepSize regardless of success/failure
      stepSize = originalStepSize;
    }
  },

  /**
   * Stop wheel servo motion
   * @param {number} servoId - Servo ID (13-15)
   * @returns {Promise<boolean>} Whether operation was successful
   */
  stopWheel: async function(servoId) {
    if (!isConnectedToRealRobot || servoId < 13 || servoId > 15) return false;
    
    console.log(`Stopping wheel servo ${servoId}`);
    try {
      await writeWheelSpeed(servoId, 0);
      console.log(`Wheel servo ${servoId} stopped`);
      wheelActive[servoId] = false;
      return true;
    } catch (error) {
      console.error(`Error stopping wheel servo ${servoId}:`, error);
      return false;
    }
  },
  
  /**
   * Stop all wheel servo motion
   * @returns {Promise<boolean>} Whether all operations were successful
   */
  stopAllWheels: async function() {
    if (!isConnectedToRealRobot) return false;
    
    console.log('Stopping all wheel servos');
    const wheelIds = [13, 14, 15];
    
    try {
      // Stop all wheels in parallel
      await Promise.all(wheelIds.map(id => this.stopWheel(id)));
      return true;
    } catch (error) {
      console.error('Error stopping all wheel servos:', error);
      return false;
    }
  },
  
  /**
   * Get joint name from index
   * @param {Object} robot - Robot object
   * @param {number} jointIndex - Joint index
   * @returns {string|null} - Joint name or null if not found
   */
  getJointNameByIndex: function(robot, jointIndex) {
    const jointNames = robot && robot.joints ? 
      Object.keys(robot.joints).filter(name => robot.joints[name].jointType !== 'fixed') : [];
    
    return jointIndex < jointNames.length ? jointNames[jointIndex] : null;
  },
  
  /**
   * Check if servo has an error
   * @param {number} servoId - Servo ID
   * @returns {boolean} - Whether servo has an error
   */
  isServoInErrorState: function(servoId) {
    return servoCommStatus[servoId] && servoCommStatus[servoId].status === 'error';
  },
  
  /**
   * Update robot's matrix world
   * @param {Object} robot - Robot object
   */
  updateRobot: function(robot) {
    if (robot && robot.updateMatrixWorld) {
      robot.updateMatrixWorld(true);
    }
  },

  /**
   * Set joint position using a normalized value (0-1) between its limits
   * @param {Object} robot - Robot object
   * @param {number} jointIndex - Joint index
   * @param {number} normalizedPosition - Position value between 0 and 1
   * @param {boolean} [invertDirection=false] - Whether to invert the direction (0 becomes 1, 1 becomes 0)
   * @returns {Promise<boolean>} Whether operation was successful
   */
  setJointPositionNormalized: async function(robot, jointIndex, normalizedPosition, invertDirection = false) {
    // Get joint name from index
    const jointName = this.getJointNameByIndex(robot, jointIndex);
    if (!jointName) {
      console.warn(`Invalid joint index: ${jointIndex}`);
      return false;
    }

    // Invert the normalized position if requested
    if (invertDirection) {
      normalizedPosition = 1 - normalizedPosition;
    }

    // Get joint and its limits
    const joint = robot.joints[jointName];
    const jointMin = joint.limit.lower;
    const jointMax = joint.limit.upper;
    
    // Calculate the actual joint position
    const position = jointMin + (normalizedPosition * (jointMax - jointMin));
    
    // Clamp the position to joint limits
    const clampedPosition = Math.max(jointMin, Math.min(jointMax, position));
    
    // Get servo ID
    const servoId = getServoIdFromJointIndex(jointIndex);
    
    // Convert joint position to servo position (0-4095)
    const servoPosition = Math.round((clampedPosition / (2 * Math.PI)) * 4096);
    
    // Update servo position if connected to real robot
    if (isConnectedToRealRobot) {
      try {
        await writeServoPosition(servoId, servoPosition);
      } catch (error) {
        console.error(`Error setting servo ${servoId} position:`, error);
        return false;
      }
    }
    
    // Update virtual joint
    joint.setJointValue(clampedPosition);
    
    // Update robot's matrix world
    this.updateRobot(robot);
    
    return true;
  }
};

// Get initial stepSize from the HTML slider
const speedControl = document.getElementById('speedControl');
let stepSize = speedControl ? MathUtils.degToRad(parseFloat(speedControl.value)) : MathUtils.degToRad(0.2);


/**
 * 设置键盘控制
 * @param {Object} robot - 要控制的机器人对象
 * @returns {Function} 用于在渲染循环中更新关节的函数
 */
export function setupKeyboardControls(robot) {
  const keyState = {};
  // Get the keyboard control section element
  const keyboardControlSection = document.getElementById('keyboardControlSection');
  let keyboardActiveTimeout;

  
  // 默认的按键-关节映射
  const keyMappings = {
    // Left arm controls (using number keys)
    '1': [{ jointIndex: 0, direction: 1, servoId: 1 }],  // Left Rotation +
    'q': [{ jointIndex: 0, direction: -1, servoId: 1 }], // Left Rotation -
    '2': [{ jointIndex: 1, direction: 1, servoId: 2 }],  // Left Pitch +
    'w': [{ jointIndex: 1, direction: -1, servoId: 2 }], // Left Pitch -
    '3': [{ jointIndex: 2, direction: 1, servoId: 3 }],  // Left Elbow +
    'e': [{ jointIndex: 2, direction: -1, servoId: 3 }], // Left Elbow -
    '4': [{ jointIndex: 3, direction: 1, servoId: 4 }],  // Left Wrist Pitch +
    'r': [{ jointIndex: 3, direction: -1, servoId: 4 }], // Left Wrist Pitch -
    '5': [{ jointIndex: 4, direction: 1, servoId: 5 }], // Left Wrist Roll +
    't': [{ jointIndex: 4, direction: -1, servoId: 5 }],// Left Wrist Roll -
    '6': [{ jointIndex: 5, direction: 1, servoId: 6 }], // Left Jaw +
    'y': [{ jointIndex: 5, direction: -1, servoId: 6 }],// Left Jaw -
    
    // Right arm controls (using ASDFGH and ZXCVBN keys)
    'a': [{ jointIndex: 6, direction: 1, servoId: 7 }],  // Right Rotation +
    'z': [{ jointIndex: 6, direction: -1, servoId: 7 }], // Right Rotation -
    's': [{ jointIndex: 7, direction: 1, servoId: 8 }],  // Right Pitch +
    'x': [{ jointIndex: 7, direction: -1, servoId: 8 }], // Right Pitch -
    'd': [{ jointIndex: 8, direction: 1, servoId: 9 }],  // Right Elbow +
    'c': [{ jointIndex: 8, direction: -1, servoId: 9 }], // Right Elbow -
    'f': [{ jointIndex: 9, direction: 1, servoId: 10 }],  // Right Wrist Pitch +
    'v': [{ jointIndex: 9, direction: -1, servoId: 10 }], // Right Wrist Pitch -
    'g': [{ jointIndex: 10, direction: 1, servoId: 11 }],  // Right Wrist Roll +
    'b': [{ jointIndex: 10, direction: -1, servoId: 11 }], // Right Wrist Roll -
    'h': [{ jointIndex: 11, direction: 1, servoId: 12 }],  // Right Jaw +
    'n': [{ jointIndex: 11, direction: -1, servoId: 12 }], // Right Jaw -
    
    // Wheel controls using arrow keys (based on robotConfig.js)
    'arrowup': [
      { jointIndex: 12, direction: 1, servoId: 13 },
      { jointIndex: 14, direction: -1, servoId: 15 }
    ],
    'arrowdown': [
      { jointIndex: 12, direction: -1, servoId: 13 },
      { jointIndex: 14, direction: 1, servoId: 15 }
    ],
    'arrowleft': [
      { jointIndex: 12, direction: 1, servoId: 13 },
      { jointIndex: 13, direction: 1, servoId: 14 },
      { jointIndex: 14, direction: 1, servoId: 15 }
    ],
    'arrowright': [
      { jointIndex: 12, direction: -1, servoId: 13 },
      { jointIndex: 13, direction: -1, servoId: 14 }, 
      { jointIndex: 14, direction: -1, servoId: 15 }
    ],
  };
  
  // Function to set the div as active
  const setKeyboardSectionActive = () => {
    if (keyboardControlSection) {
      keyboardControlSection.classList.add('control-active');
      
      // Clear existing timeout if any
      if (keyboardActiveTimeout) {
        clearTimeout(keyboardActiveTimeout);
      }
      
      // Set timeout to remove the active class after 2 seconds of inactivity
      keyboardActiveTimeout = setTimeout(() => {
        keyboardControlSection.classList.remove('control-active');
      }, 2000);
    }
  };
  
  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    console.log('Key pressed:', key);
    
    // 如果是新按下的键，检查是否需要处理
    const isKeyChange = !keyState[key];
    keyState[key] = true;
    
    // Add visual styling to show pressed key
    const keyElement = document.querySelector(`.key[data-key="${key}"]`);
    if (keyElement) {
      keyElement.classList.add('key-pressed');
      
      // Highlight the keyboard control section
      setKeyboardSectionActive();
    }
  });

  window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    const wasKeyPressed = keyState[key];
    keyState[key] = false;
    
    console.log('Key released:', key);
    
    // Remove visual styling when key is released
    const keyElement = document.querySelector(`.key[data-key="${key}"]`);
    if (keyElement) {
      keyElement.classList.remove('key-pressed');
    }
    
    // 如果释放的是方向键，停止对应的轮子舵机
    if (wasKeyPressed && ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
      stopWheelsForKey(key);
    }
  });

  // 添加速度控制功能
  if (speedControl) {
    speedControl.addEventListener('input', (e) => {
      // 从滑块获取值 (0.5 到 10)，然后转换为弧度
      const speedFactor = parseFloat(e.target.value);
      stepSize = MathUtils.degToRad(speedFactor);
      
      // 更新速度显示
      const speedDisplay = document.getElementById('speedValue');
      if (speedDisplay) {
        speedDisplay.textContent = speedFactor.toFixed(1);
      }
    });
  }

  /**
   * 停止与指定按键相关的轮子舵机
   * @param {string} key - 释放的按键
   */
  function stopWheelsForKey(key) {
    if (!isConnectedToRealRobot) return;
    
    console.log(`Processing wheel stop for key: ${key}`);
    
    // 检查按键映射中是否包含该键
    if (keyMappings[key] && Array.isArray(keyMappings[key])) {
      // 获取该键对应的所有舵机ID
      const servoIds = keyMappings[key].map(mapping => mapping.servoId);
      
      // 检查当前是否有其他方向键被按下
      const otherKeysPressed = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright']
        .filter(k => k !== key && keyState[k]);
      
      console.log(`Other direction keys pressed: ${otherKeysPressed.join(', ') || 'none'}`);
      
      // 对于每个舵机，检查是否需要停止
      servoIds.forEach(servoId => {
        if (servoId >= 13 && servoId <= 15) {
          // 检查其他按下的键是否也控制这个舵机
          let shouldStop = true;
          
          // 检查其他按键是否控制这个舵机
          for (const otherKey of otherKeysPressed) {
            if (Array.isArray(keyMappings[otherKey])) {
              const controlsThisServo = keyMappings[otherKey].some(m => m.servoId === servoId);
              if (controlsThisServo) {
                shouldStop = false;
                console.log(`Servo ${servoId} still controlled by ${otherKey}, not stopping`);
                break;
              }
            }
          }
          
          // 如果需要停止，发送停止命令
          if (shouldStop) {
            console.log(`Stopping wheel servo ${servoId} (key ${key} released)`);
            robotControl.stopWheel(servoId);
          }
        }
      });
    }
  }

  function updateJoints() {
    if (!robot || !robot.joints) return;

    let keyPressed = false;

    // 处理每个按键映射
    Object.keys(keyState).forEach(key => {
      if (keyState[key] && keyMappings[key]) {
        keyPressed = true;
        
        // Process all mappings for this key (now all are arrays)
        keyMappings[key].forEach(mapping => {
          const { jointIndex, direction, servoId } = mapping;
          
          // 检查关节是否存在于机器人中
          if (isConnectedToRealRobot && servoCommStatus[servoId].status === 'error') {
            console.warn(`Servo ${servoId} is in error state. Virtual movement prevented.`);
            return; // 跳过这个关节的更新
          }
          
          // 使用通用舵机控制函数
          robotControl.controlJoint(robot, jointIndex, direction);
        });
      }
    });

    // If any key is pressed, set the keyboard section as active
    if (keyPressed) {
      setKeyboardSectionActive();
    }

    // 更新机器人
    robotControl.updateRobot(robot);
  }

  
  // 返回更新函数，以便可以在渲染循环中调用
  return updateJoints;
}

export function setupJoyconControls(robot) {
  // 扁平化 joyconState，直接记录按钮状态
  const joyconState = {
    // 按钮状态
    up: false,
    down: false,
    left: false,
    right: false,
    a: false,
    b: false,
    x: false,
    y: false,
    l: false,
    zl: false,
    r: false,
    zr: false,
    plus: false,
    minus: false,
    // 右摇杆
    home: false,
    capture: false,


    leftStickRight: false,
    leftStickLeft: false,
    leftStickUp: false,
    leftStickDown: false,
    rightStickRight: false,
    rightStickLeft: false,
    rightStickUp: false,
    rightStickDown: false,
    
    // 扁平化的方向数据
    leftOrientationAlpha: 0,
    leftOrientationBeta: 0,
    leftOrientationGamma: 0,
    rightOrientationAlpha: 0,
    rightOrientationBeta: 0,
    rightOrientationGamma: 0,
    
    // 扁平化摇杆数据 - 直接作为按钮状态
    leftStickRight: false,
    leftStickLeft: false,
    leftStickUp: false, 
    leftStickDown: false,
    rightStickRight: false,
    rightStickLeft: false,
    rightStickUp: false,
    rightStickDown: false,
    
    // 记录哪些控制器已连接
    leftConnected: false,
    rightConnected: false
  };

  const buttonMapping = {
    'rightStickRight': [{ jointIndex: 0, direction: 1 }], // Base rotation right
    'rightStickLeft': [{ jointIndex: 0, direction: -1 }], // Base rotation left
    'rightStickUp': [{ jointIndex: 2, direction: -1 }], // Right shoulder up
    'rightStickDown': [{ jointIndex: 2, direction: 1 }], // Right shoulder down
    'x': [{ jointIndex: 1, direction: 1 }],
    'b': [{ jointIndex: 1, direction: -1 }],
    'r': [{jointIndex: 5, direction: 1}],
    'zr': [{jointIndex: 5, direction: -1}],


    'leftStickRight': [{ jointIndex: 6, direction: 1 }], // Left shoulder right
    'leftStickLeft': [{ jointIndex: 6, direction: -1 }], // Left shoulder left
    'leftStickUp': [{ jointIndex: 8, direction: -1 }],
    'leftStickDown': [{ jointIndex: 8, direction: 1 }],
    'up': [{ jointIndex: 7, direction: 1 }],
    'down': [{ jointIndex: 7, direction: -1 }],
    'l': [{jointIndex: 11, direction: 1}],
    'zl': [{jointIndex: 11, direction: -1}],


    'plus': [
      { jointIndex: 12, direction: 1 }, // Left wheel forward
      { jointIndex: 14, direction: -1 } // Right wheel forward
    ],
    'minus': [
      { jointIndex: 12, direction: -1 }, // Left wheel backward
      { jointIndex: 14, direction: 1 } // Right wheel backward
    ],
    'y': [
      { jointIndex: 12, direction: 1, servoId: 13 },
      { jointIndex: 13, direction: 1, servoId: 14 },
      { jointIndex: 14, direction: 1, servoId: 15 }
    ], // 左转 - 所有轮子正向
    'a': [
      { jointIndex: 12, direction: -1, servoId: 13 },
      { jointIndex: 13, direction: -1, servoId: 14 },
      { jointIndex: 14, direction: -1, servoId: 15 }
    ], // 右转 - 所有轮子反向
  }

  const connectLeftButton = document.getElementById('connectLeftJoycon');
  const connectRightButton = document.getElementById('connectRightJoycon');  
  connectLeftButton.addEventListener('click', connectJoyCon);
  connectRightButton.addEventListener('click', connectJoyCon);

  console.log('connectedJoyCons in setupJoyconControls', connectedJoyCons);

  const leftJoycon = document.getElementById('joycon-l');
  const rightJoycon = document.getElementById('joycon-r');
  // Function to update UI based on connected joycons
  function updateJoyconDisplay() {
    for (const joyCon of connectedJoyCons.values()) {
      if (joyCon instanceof JoyConLeft) {
        // Hide button and show joycon figure
        connectLeftButton.style.display = 'none';
        if (leftJoycon) leftJoycon.style.display = 'inline-block';
      } else if (joyCon instanceof JoyConRight) {
        // Hide button and show joycon figure
        connectRightButton.style.display = 'none';
        if (rightJoycon) rightJoycon.style.display = 'inline-block';
      }
    }
  }

  const rootStyle = document.documentElement.style;
  // Visualize function to handle joycon inputs
  function visualize(joyConSide, buttons, orientation, joystick) {
    if (joyConSide === 'left') {
      rootStyle.setProperty('--left-alpha', `${orientation.alpha}deg`);
      rootStyle.setProperty('--left-beta', `${orientation.beta}deg`);
      rootStyle.setProperty('--left-gamma', `${orientation.gamma}deg`);
    } else if (joyConSide === 'right') {
      rootStyle.setProperty('--right-alpha', `${orientation.alpha}deg`);
      rootStyle.setProperty('--right-beta', `${orientation.beta}deg`);
      rootStyle.setProperty('--right-gamma', `${orientation.gamma}deg`);
    }
  
    if (joyConSide === 'left') {
      const joystickMultiplier = 10;
      document.querySelector('#joystick-left').style.transform = `translateX(${
        joystick.horizontal * joystickMultiplier
      }px) translateY(${joystick.vertical * joystickMultiplier}px)`;
  
      document.querySelector('#up').classList.toggle('highlight', buttons.up);
      document.querySelector('#down').classList.toggle('highlight', buttons.down);
      document.querySelector('#left').classList.toggle('highlight', buttons.left);
      document
        .querySelector('#right')
        .classList.toggle('highlight', buttons.right);
      document
        .querySelector('#capture')
        .classList.toggle('highlight', buttons.capture);
      document
        .querySelector('#l')
        .classList.toggle('highlight', buttons.l || buttons.zl);
      document
        .querySelector('#minus')
        .classList.toggle('highlight', buttons.minus);
      document
        .querySelector('#joystick-left')
        .classList.toggle('highlight', buttons.leftStick);
    }
    if (joyConSide === 'right') {
      const joystickMultiplier = 10;
      document.querySelector('#joystick-right').style.transform = `translateX(${
        joystick.horizontal * joystickMultiplier
      }px) translateY(${joystick.vertical * joystickMultiplier}px)`;
  
      document.querySelector('#a').classList.toggle('highlight', buttons.a);
      document.querySelector('#b').classList.toggle('highlight', buttons.b);
      document.querySelector('#x').classList.toggle('highlight', buttons.x);
      document.querySelector('#y').classList.toggle('highlight', buttons.y);
      document.querySelector('#home').classList.toggle('highlight', buttons.home);
      document
        .querySelector('#r')
        .classList.toggle('highlight', buttons.r || buttons.zr);
      document.querySelector('#plus').classList.toggle('highlight', buttons.plus);
      document
        .querySelector('#joystick-right')
        .classList.toggle('highlight', buttons.rightStick);
    }
  }

  setInterval(async () => {
    // Update UI based on connected joycons
    updateJoyconDisplay();
    
    for (const joyCon of connectedJoyCons.values()) {
      if (joyCon.eventListenerAttached) {
        continue;
      }
      joyCon.eventListenerAttached = true;
      // await joyCon.enableVibration();
      joyCon.addEventListener('hidinput', (event) => {
        const packet = event.detail;
        if (!packet || !packet.actualOrientation) {
          return;
        }
        const {
          buttonStatus: buttons,
          actualOrientation: orientation,
          analogStickLeft: analogStickLeft,
          analogStickRight: analogStickRight,
        } = packet;

        // update joyconState with flattened structure
        if (joyCon instanceof JoyConLeft) {
          // Update orientation and analog stick
          joyconState.leftOrientationAlpha = orientation.alpha;
          joyconState.leftOrientationBeta = orientation.beta;
          joyconState.leftOrientationGamma = orientation.gamma;
          joyconState.leftConnected = true;
          
          // Update buttons from left Joy-Con
          joyconState.up = buttons.up;
          joyconState.down = buttons.down;
          joyconState.left = buttons.left;
          joyconState.right = buttons.right;
          joyconState.l = buttons.l;
          joyconState.zl = buttons.zl;
          joyconState.minus = buttons.minus;
          joyconState.capture = buttons.capture;
          joyconState.leftStickRight = analogStickLeft.horizontal > 0.2;
          joyconState.leftStickLeft = analogStickLeft.horizontal < -0.2;
          joyconState.leftStickUp = analogStickLeft.vertical > 0.2;
          joyconState.leftStickDown = analogStickLeft.vertical < -0.2;
          
          visualize('left', buttons, orientation, analogStickLeft);
        } else if (joyCon instanceof JoyConRight) {
          // Update orientation and analog stick
          joyconState.rightOrientationAlpha = orientation.alpha;
          joyconState.rightOrientationBeta = orientation.beta;
          joyconState.rightOrientationGamma = orientation.gamma;
          joyconState.rightConnected = true;
          // Update buttons from right Joy-Con
          joyconState.a = buttons.a;
          joyconState.b = buttons.b;
          joyconState.x = buttons.x;
          joyconState.y = buttons.y;
          joyconState.r = buttons.r;
          joyconState.zr = buttons.zr;
          joyconState.plus = buttons.plus;
          joyconState.home = buttons.home;
          joyconState.rightStickRight = analogStickRight.horizontal > 0.2;
          joyconState.rightStickLeft = analogStickRight.horizontal < -0.2;
          joyconState.rightStickUp = analogStickRight.vertical > 0.2;
          joyconState.rightStickDown = analogStickRight.vertical < -0.2;
          
          visualize('right', buttons, orientation, analogStickRight);
        }
      });
    }
  }, 2000);

  function updateJoints() {
    if (!robot || !robot.joints || !joyconState) return;
    
    // Check if any Joy-Con is connected
    if (!joyconState.leftConnected && !joyconState.rightConnected) return;

    // Process all button mappings directly
    Object.keys(buttonMapping).forEach(button => {
      if (joyconState[button]) {
        buttonMapping[button].forEach(mapping => {
          const { jointIndex, direction } = mapping;
          robotControl.controlJoint(robot, jointIndex, direction);
        });
      }
    });

    // Helper function to map orientation to joint position
    const mapOrientationToJoint = (angle, jointIndex, invertDirection = false) => {
      // Clamp angle to -90 to 90 degrees range
      const clampedAngle = Math.max(-90, Math.min(90, angle));
      
      // Calculate normalized position (0 to 1)
      const normalizedPosition = (clampedAngle + 90) / 180;
      
      // Set joint position with optional direction inversion
      robotControl.setJointPositionNormalized(robot, jointIndex, normalizedPosition, invertDirection);
    };

    // Add orientation controls for right Joy-Con
    if (joyconState.rightConnected) {
      // Beta controls joint 3 (index 2)
      mapOrientationToJoint(joyconState.rightOrientationBeta, 3, true);
      
      // Gamma controls joint 4 (index 3)
      mapOrientationToJoint(joyconState.rightOrientationGamma, 4, true);
    }
    
    // Add orientation controls for left Joy-Con
    if (joyconState.leftConnected) {
      // Beta controls joint 9 (index 8)
      mapOrientationToJoint(joyconState.leftOrientationBeta, 9, true);
      
      // Gamma controls joint 10 (index 9)
      mapOrientationToJoint(joyconState.leftOrientationGamma, 10, true);
    }
    
    // Update robot's matrix world
    robotControl.updateRobot(robot);
  }
  return updateJoints;
}

/**
 * 设置控制面板UI
 */
export function setupControlPanel() {
  const controlPanel = document.getElementById('controlPanel');
  const togglePanel = document.getElementById('togglePanel');
  const hideControls = document.getElementById('hideControls');

  // 处理折叠/展开控制面板
  if (hideControls) {
    hideControls.addEventListener('click', () => {
      controlPanel.style.display = 'none';
      togglePanel.style.display = 'block';
    });
  }

  if (togglePanel) {
    togglePanel.addEventListener('click', () => {
      controlPanel.style.display = 'block';
      togglePanel.style.display = 'none';
    });
  }

  // 初始化速度显示
  const speedDisplay = document.getElementById('speedValue');
  const speedControl = document.getElementById('speedControl');
  if (speedDisplay && speedControl) {
    speedDisplay.textContent = speedControl.value;
  }
  
  // 设置可折叠部分的逻辑
  setupCollapsibleSections();

  // 添加真实机器人连接事件处理 - 所有舵机
  const connectButton = document.getElementById('connectRealRobot');
  if (connectButton) {
    connectButton.addEventListener('click', () => toggleRealRobotConnection(servoGroups.all));
  }
}

/**
 * 设置可折叠部分的功能
 */
function setupCollapsibleSections() {
  // 获取所有可折叠部分的标头
  const collapsibleHeaders = document.querySelectorAll('.collapsible-header');
  
  collapsibleHeaders.forEach(header => {
    header.addEventListener('click', () => {
      // 切换当前可折叠部分的打开/关闭状态
      const section = header.parentElement;
      section.classList.toggle('open');
    });
  });
}

/**
 * 通用舵机错误处理函数
 * @param {number} servoId - 舵机ID (1-6)
 * @param {number} result - 通信结果代码
 * @param {number} error - 错误代码
 * @param {string} operation - 操作类型描述（如'read'、'position'等）
 * @param {boolean} isWarning - 是否作为警告处理（而非错误）
 * @returns {boolean} 操作是否成功
 */
function handleServoError(servoId, result, error, operation, isWarning = false) {
  if (!servoCommStatus[servoId]) return false;
  
  if (result === COMM_SUCCESS && !isWarning) {
    servoCommStatus[servoId].status = 'success';
    servoCommStatus[servoId].lastError = null;
    return true;
  }
  
  // 设置状态（警告或错误）
  servoCommStatus[servoId].status = isWarning ? 'warning' : 'error';
  
  // 构造状态前缀
  const statusPrefix = isWarning ? '' : (result !== COMM_SUCCESS ? 'Communication failed: ' : '');
  
  let errorMessage = '';
  
  // 检查错误码
  if (error & ERRBIT_OVERLOAD) {
    errorMessage = `${statusPrefix}Overload or stuck${!isWarning ? ` (code: ${result})` : ''}`;
    servoCommStatus[servoId].lastError = errorMessage;
    const logFn = isWarning ? console.warn : console.error;
    logFn(`Servo ${servoId} ${operation} ${isWarning ? 'warning' : 'failed'} with overload error (${error})`);
  } else if (error & ERRBIT_OVERHEAT) {
    errorMessage = `${statusPrefix}Overheat${!isWarning ? ` (code: ${result})` : ''}`;
    servoCommStatus[servoId].lastError = errorMessage;
    const logFn = isWarning ? console.warn : console.error;
    logFn(`Servo ${servoId} ${operation} ${isWarning ? 'warning' : 'failed'} with overheat error (${error})`);
  } else if (error & ERRBIT_VOLTAGE) {
    errorMessage = `${statusPrefix}Voltage error${!isWarning ? ` (code: ${result})` : ''}`;
    servoCommStatus[servoId].lastError = errorMessage;
    const logFn = isWarning ? console.warn : console.error;
    logFn(`Servo ${servoId} ${operation} ${isWarning ? 'warning' : 'failed'} with voltage error (${error})`);
  } else if (error & ERRBIT_ANGLE) {
    errorMessage = `${statusPrefix}Angle sensor error${!isWarning ? ` (code: ${result})` : ''}`;
    servoCommStatus[servoId].lastError = errorMessage;
    const logFn = isWarning ? console.warn : console.error;
    logFn(`Servo ${servoId} ${operation} ${isWarning ? 'warning' : 'failed'} with angle sensor error (${error})`);
  } else if (error & ERRBIT_OVERELE) {
    errorMessage = `${statusPrefix}Overcurrent${!isWarning ? ` (code: ${result})` : ''}`;
    servoCommStatus[servoId].lastError = errorMessage;
    const logFn = isWarning ? console.warn : console.error;
    logFn(`Servo ${servoId} ${operation} ${isWarning ? 'warning' : 'failed'} with overcurrent error (${error})`);
  } else if (error !== 0 || result !== COMM_SUCCESS) {
    errorMessage = `${statusPrefix}${isWarning ? 'Unknown error code' : operation + ' failed'}: ${error}${!isWarning ? ` (code: ${result})` : ''}`;
    servoCommStatus[servoId].lastError = errorMessage;
    const logFn = isWarning ? console.warn : console.error;
    logFn(`Servo ${servoId} ${isWarning ? 'returned unknown error code' : operation + ' failed'}: ${error}`);
  } else {
    // 不太可能到达这里，但以防万一
    servoCommStatus[servoId].status = 'success';
    servoCommStatus[servoId].lastError = null;
    return true;
  }
  
  // 在UI上显示错误提醒，严重错误才弹出提醒
  if (!isWarning || error & (ERRBIT_OVERLOAD | ERRBIT_OVERHEAT | ERRBIT_VOLTAGE)) {
    showAlert('servo', `Servo ${servoId}: ${errorMessage}`);
  }
  
  updateServoStatusUI();
  return false;
}

// 添加真实机器人操作相关的函数
/**
 * 切换真实机器人连接状态
 * @param {Array} [targetServos] - 可选参数，指定要连接的舵机ID数组，不提供则连接所有舵机
 */
async function toggleRealRobotConnection(targetServos) {
  const connectButton = document.getElementById('connectRealRobot');
  const servoStatusContainer = document.getElementById('servoStatusContainer');
  
  if (!connectButton) return;
  
  // 如果未指定目标舵机，则默认连接所有舵机
  if (!targetServos) {
    targetServos = servoGroups.all; // 使用所有舵机
  }
  
  if (!isConnectedToRealRobot) {
    try {
      // Create new instances if needed
      if (!portHandler) portHandler = new PortHandler();
      
      // 使用固定的协议类型 SCS(1)
      const protocolEnd = 1;
      if (!packetHandler || packetHandler.getProtocolEnd() !== protocolEnd) {
        packetHandler = new PacketHandler(protocolEnd);
      }
      
      // Request serial port
      connectButton.disabled = true;
      connectButton.textContent = 'Connecting...';
      
      // 重置目标舵机状态为idle
      targetServos.forEach(servoId => {
        servoCommStatus[servoId] = { status: 'idle', lastError: null };
      });
      updateServoStatusUI();
      
      // 显示舵机状态区域
      if (servoStatusContainer) {
        servoStatusContainer.style.display = 'block';
        // 确保状态面板默认是打开的
        servoStatusContainer.classList.add('open');
      }
      
      const success = await portHandler.requestPort();
      if (!success) {
        throw new Error('Failed to select port');
      }
      
      // 使用固定波特率 1000000
      const baudrate = 1000000;
      portHandler.setBaudRate(baudrate);
      
      // Open the port
      const opened = await portHandler.openPort();
      if (!opened) {
        throw new Error('Failed to open port');
      }
      
      // 清空命令队列
      commandQueue = [];
      isProcessingQueue = false;
      
      // Set initial parameters for servos (e.g. acceleration)
      for (const servoId of targetServos) {
        try {
          // 更新舵机状态为处理中
          servoCommStatus[servoId].status = 'pending';
          updateServoStatusUI();
          
          // 先启用扭矩 - 集中一次性处理
          await writeTorqueEnable(servoId, 1);
          
          // 区分轮子舵机和非轮子舵机的初始化
          if (servoId >= 13 && servoId <= 15) {
            // 轮子舵机设置为轮模式（连续旋转模式）
            const wheelModeSuccess = await setWheelMode(servoId);
            if (!wheelModeSuccess) {
              console.warn(`Failed to set wheel mode for servo ${servoId}`);
            }
            
            // 设置轮子初始速度为0（停止状态）
            await writeWheelSpeed(servoId, 0);
            
            servoCommStatus[servoId].status = 'success';
            console.log(`Wheel servo ${servoId} initialized in wheel mode`);
          } else {
            // 非轮子舵机使用常规初始化
            // 按顺序执行，等待每个操作完成
            await writeServoAcceleration(servoId, 10);
            await writeServoSpeed(servoId, 300);
            
            // 读取当前位置并保存
            // TODO: 需要读取吗？目前的回到没错位置功能是坏的
            const currentPosition = await readServoPosition(servoId);
            if (currentPosition !== null) {
              servoCurrentPositions[servoId] = currentPosition;
              // 同时设置为最后安全位置
              servoLastSafePositions[servoId] = currentPosition;
              console.log(`Servo ${servoId} current position: ${currentPosition}`);
              
              // 读取成功，更新状态为success
              servoCommStatus[servoId].status = 'success';
            } else {
              console.warn(`Could not read current position for Servo ${servoId}, using default 0`);
              
              // 读取失败，更新状态为error
              servoCommStatus[servoId].status = 'error';
              servoCommStatus[servoId].lastError = 'Failed to read initial position';
            }
          }
          
          updateServoStatusUI();
        } catch (err) {
          console.warn(`Error initializing servo ${servoId}:`, err);
          servoCommStatus[servoId].status = 'error';
          servoCommStatus[servoId].lastError = err.message || 'Initialization error';
          updateServoStatusUI();
        }
      }
      
      // Update UI
      connectButton.classList.add('connected');
      connectButton.textContent = 'Disconnect Robot';
      isConnectedToRealRobot = true;
      
    } catch (error) {
      console.error('Connection error:', error);
      alert(`Failed to connect: ${error.message}`);
      connectButton.textContent = 'Connect Real Robot';
      connectButton.classList.remove('connected');
      
      // 显示连接错误提醒
      showAlert('servo', `Failed to connect to robot: ${error.message}`, 5000);
      
      // 连接失败，更新目标舵机状态为error
      targetServos.forEach(servoId => {
        servoCommStatus[servoId].status = 'error';
        servoCommStatus[servoId].lastError = error.message || 'Connection failed';
      });
      updateServoStatusUI();
    } finally {
      connectButton.disabled = false;
    }
  } else {
    // Disconnect
    try {
      // 清空命令队列
      commandQueue = [];
      isProcessingQueue = false;
      
      if (portHandler && portHandler.isOpen) {
        // 先停止所有轮子舵机，防止断开连接后继续运动
        const wheelServos = targetServos.filter(id => id >= 13 && id <= 15);
        for (const wheelId of wheelServos) {
          try {
            // 停止轮子转动
            await writeWheelSpeed(wheelId, 0);
            console.log(`Stopped wheel servo ${wheelId} before disconnecting`);
          } catch (err) {
            console.warn(`Error stopping wheel servo ${wheelId}:`, err);
          }
        }
        
        // Turn off torque before closing
        for (const servoId of targetServos) {
          try {
            await writeTorqueEnable(servoId, 0);
          } catch (err) {
            console.warn(`Error disabling torque for servo ${servoId}:`, err);
          }
        }
        
        await portHandler.closePort();
      }
      
      // 重置目标舵机状态和位置信息
      targetServos.forEach(servoId => {
        servoCommStatus[servoId] = { status: 'idle', lastError: null };
        servoCurrentPositions[servoId] = 0;
        servoLastSafePositions[servoId] = 0;
      });
      
      // 隐藏舵机状态区域
      if (servoStatusContainer) {
        servoStatusContainer.style.display = 'none';
      }
      
      // Update UI
      connectButton.classList.remove('connected');
      connectButton.textContent = 'Connect Real Robot';
      isConnectedToRealRobot = false;
    } catch (error) {
      console.error('Disconnection error:', error);
    }
  }
}

/**
 * 读取舵机当前位置
 * @param {number} servoId - 舵机ID (1-6)
 * @returns {number|null} 当前位置值 (0-4095)或失败时返回null
 */
async function readServoPosition(servoId) {
  if (!portHandler || !packetHandler) return null;
  
  return queueCommand(async () => {
    try {
      // 更新舵机状态为处理中
      if (servoCommStatus[servoId]) {
        servoCommStatus[servoId].status = 'pending';
        servoCommStatus[servoId].lastError = null;
        updateServoStatusUI();
      }
      
      // 读取当前位置
      const [rawPosition, result, error] = await packetHandler.read4ByteTxRx(
        portHandler,
        servoId,
        ADDR_SCS_PRESENT_POSITION
      );
      
      // 使用通用错误处理函数
      if (!handleServoError(servoId, result, error, 'position reading')) {
        return null;
      }
      
      // 修复字节顺序问题 - 通常SCS舵机使用小端序(Little Endian)
      // 从0xD04变为0x40D (从3332变为1037)
      // 我们只关心最低的两个字节，所以可以通过位运算修复
      const lowByte = (rawPosition & 0xFF00) >> 8;  // 取高字节并右移到低位
      const highByte = (rawPosition & 0x00FF) << 8; // 取低字节并左移到高位
      const position = (rawPosition & 0xFFFF0000) | highByte | lowByte;
      
      // 输出调试信息
      console.log(`Servo ${servoId} raw: 0x${rawPosition.toString(16)}, fixed: 0x${position.toString(16)}`);
      
      return position & 0xFFFF; // 只取低16位，这是舵机位置的有效范围
    } catch (error) {
      console.error(`Error reading position from servo ${servoId}:`, error);
      
      // 更新舵机状态为错误
      if (servoCommStatus[servoId]) {
        servoCommStatus[servoId].status = 'error';
        servoCommStatus[servoId].lastError = error.message || 'Communication error';
        updateServoStatusUI();
      }
      
      return null;
    }
  });
}

/**
 * 写入舵机位置
 * @param {number} servoId - 舵机ID (1-6)
 * @param {number} position - 位置值 (0-4095)
 * @param {boolean} [skipLimitCheck=false] - 是否为恢复操作，已不再检查虚拟关节限制
 */
async function writeServoPosition(servoId, position, skipLimitCheck = false) {
  if (!isConnectedToRealRobot || !portHandler || !packetHandler) return;
  
  return queueCommand(async () => {
    try {
      // 更新舵机状态为处理中
      servoCommStatus[servoId].status = 'pending';
      servoCommStatus[servoId].lastError = null;
      updateServoStatusUI();
      
      // Write position to servo
      position = Math.max(0, Math.min(4095, position)); // Clamp to valid range
      
      // 修复字节顺序问题 - 通常SCS舵机使用小端序(Little Endian)
      // 从0x40D变为0xD04 (从1037变为3332)
      // 我们只需要修正低16位中的字节顺序
      const lowByte = (position & 0xFF00) >> 8;  // 取高字节并右移到低位
      const highByte = (position & 0x00FF) << 8; // 取低字节并左移到高位
      const adjustedPosition = (position & 0xFFFF0000) | highByte | lowByte;
      
      const [result, error] = await packetHandler.write4ByteTxRx(
        portHandler, 
        servoId, 
        ADDR_SCS_GOAL_POSITION, 
        adjustedPosition & 0xFFFF // 只使用低16位
      );
      
      // 使用通用错误处理函数，通信成功但有错误时作为警告处理
      const isSuccess = result === COMM_SUCCESS;
      if (isSuccess && error !== 0) {
        // 通信成功但有硬件警告
        handleServoError(servoId, result, error, 'position control', true);
      } else {
        // 通信失败或无错误
        handleServoError(servoId, result, error, 'position control');
      }
      
      return isSuccess;
    } catch (error) {
      console.error(`Error writing position to servo ${servoId}:`, error);
      servoCommStatus[servoId].status = 'error';
      servoCommStatus[servoId].lastError = error.message || 'Communication error';
      updateServoStatusUI();
      throw error;
    }
  });
}

/**
 * 设置舵机加速度
 * @param {number} servoId - 舵机ID (1-6)
 * @param {number} acceleration - 加速度值 (0-254)
 */
async function writeServoAcceleration(servoId, acceleration) {
  if (!isConnectedToRealRobot || !portHandler || !packetHandler) return;
  
  return queueCommand(async () => {
    try {
      // 更新舵机状态为处理中
      servoCommStatus[servoId].status = 'pending';
      servoCommStatus[servoId].lastError = null;
      updateServoStatusUI();
      
      acceleration = Math.max(0, Math.min(254, acceleration)); // Clamp to valid range
      
      const [result, error] = await packetHandler.write1ByteTxRx(
        portHandler, 
        servoId, 
        ADDR_SCS_GOAL_ACC, 
        acceleration
      );
      
      // 使用通用错误处理函数
      return handleServoError(servoId, result, error, 'acceleration control');
    } catch (error) {
      console.error(`Error writing acceleration to servo ${servoId}:`, error);
      servoCommStatus[servoId].status = 'error';
      servoCommStatus[servoId].lastError = error.message || 'Communication error';
      updateServoStatusUI();
      throw error;
    }
  });
}

/**
 * 设置舵机速度
 * @param {number} servoId - 舵机ID (1-6)
 * @param {number} speed - 速度值 (0-2000)
 */
async function writeServoSpeed(servoId, speed) {
  if (!isConnectedToRealRobot || !portHandler || !packetHandler) return;
  
  return queueCommand(async () => {
    try {
      // 更新舵机状态为处理中
      servoCommStatus[servoId].status = 'pending';
      servoCommStatus[servoId].lastError = null;
      updateServoStatusUI();
      
      speed = Math.max(0, Math.min(2000, speed)); // Clamp to valid range
      
      const [result, error] = await packetHandler.write2ByteTxRx(
        portHandler, 
        servoId, 
        ADDR_SCS_GOAL_SPEED, 
        speed
      );
      
      // 使用通用错误处理函数
      return handleServoError(servoId, result, error, 'speed control');
    } catch (error) {
      console.error(`Error writing speed to servo ${servoId}:`, error);
      servoCommStatus[servoId].status = 'error';
      servoCommStatus[servoId].lastError = error.message || 'Communication error';
      updateServoStatusUI();
      throw error;
    }
  });
}

/**
 * 设置舵机扭矩开关
 * @param {number} servoId - 舵机ID (1-6)
 * @param {number} enable - 0: 关闭, 1: 开启
 */
async function writeTorqueEnable(servoId, enable) {
  if (!isConnectedToRealRobot || !portHandler || !packetHandler) return;
  
  return queueCommand(async () => {
    try {
      // 更新舵机状态为处理中
      servoCommStatus[servoId].status = 'pending';
      servoCommStatus[servoId].lastError = null;
      updateServoStatusUI();
      
      const [result, error] = await packetHandler.write1ByteTxRx(
        portHandler, 
        servoId, 
        ADDR_SCS_TORQUE_ENABLE, 
        enable ? 1 : 0
      );
      
      // 使用通用错误处理函数
      return handleServoError(servoId, result, error, 'torque control');
    } catch (error) {
      console.error(`Error writing torque enable to servo ${servoId}:`, error);
      servoCommStatus[servoId].status = 'error';
      servoCommStatus[servoId].lastError = error.message || 'Communication error';
      updateServoStatusUI();
      throw error;
    }
  });
}

/**
 * 更新舵机通信状态UI
 */
function updateServoStatusUI() {
  // For each servo, update its status display
  for (let id = 1; id <= 15; id++) {
    const statusElement = document.getElementById(`servo-${id}-status`);
    const errorElement = document.getElementById(`servo-${id}-error`);
    
    if (statusElement) {
      // Map servo IDs 1-6 to left arm and 7-12 to right arm 
      // Display appropriate status
      if (servoCommStatus[id]) {
        statusElement.textContent = servoCommStatus[id].status;
        
        // Add visual styling based on status
        statusElement.className = 'servo-status';
        if (servoCommStatus[id].status === 'error') {
          statusElement.classList.add('warning');
        }
        
        // Handle error message display
        if (errorElement) {
          if (servoCommStatus[id].lastError) {
            errorElement.textContent = servoCommStatus[id].lastError;
            errorElement.style.display = 'block';
          } else {
            errorElement.style.display = 'none';
          }
        }
      }
    }
  }
}

/**
 * 写入轮子舵机的速度（区别于位置控制）
 * @param {number} servoId - 舵机ID (13-15)
 * @param {number} speed - 速度值 (-2000 to 2000)，负值表示反向
 * @returns {Promise<boolean>} 操作是否成功
 */
async function writeWheelSpeed(servoId, speed) {
  if (!isConnectedToRealRobot || !portHandler || !packetHandler) return false;
  
  return queueCommand(async () => {
    try {
      // 更新舵机状态为处理中
      servoCommStatus[servoId].status = 'pending';
      servoCommStatus[servoId].lastError = null;
      updateServoStatusUI();
      
      // 将速度限制在有效范围内并处理方向
      // 注意：速度为0是停止，正负值表示不同方向
      const absSpeed = Math.min(Math.abs(speed), 2000);
      
      // 舵机速度控制有两个部分：方向位和速度值
      // Feetech舵机的速度寄存器通常高位表示方向(0为正向，1为反向)
      let speedValue = absSpeed & 0x07FF; // 只取低11位作为速度值
      if (speed < 0) {
        // 设置方向位，添加反向标记
        speedValue |= 0x0800; // 设置第12位为1表示反向
      }
      
      console.log(`Setting wheel servo ${servoId} speed to ${speed > 0 ? '+' : ''}${speed} (raw: 0x${speedValue.toString(16)})`);
      
      const [result, error] = await packetHandler.write2ByteTxRx(
        portHandler, 
        servoId, 
        ADDR_SCS_GOAL_SPEED, 
        speedValue
      );
      
      // 使用通用错误处理函数
      return handleServoError(servoId, result, error, 'wheel speed control');
    } catch (error) {
      console.error(`Error writing wheel speed to servo ${servoId}:`, error);
      servoCommStatus[servoId].status = 'error';
      servoCommStatus[servoId].lastError = error.message || 'Communication error';
      updateServoStatusUI();
      throw error;
    }
  });
}

/**
 * 为轮子舵机设置轮模式（连续旋转模式）
 * @param {number} servoId - 舵机ID (13-15)
 * @returns {Promise<boolean>} 操作是否成功
 */
async function setWheelMode(servoId) {
  if (!isConnectedToRealRobot || !portHandler || !packetHandler) return false;
  
  return queueCommand(async () => {
    try {
      console.log(`Setting servo ${servoId} to wheel mode`);
      
      // 在Feetech SCS舵机中，设置位置限制为0可以启用轮模式（连续旋转）
      // 注意：确切的寄存器地址和值可能需要根据具体舵机型号调整
      const ADDR_SCS_MIN_POSITION = 9;  // 最小位置限制地址
      const ADDR_SCS_MAX_POSITION = 11; // 最大位置限制地址
      
      // 设置最小位置限制为0
      let [result1, error1] = await packetHandler.write2ByteTxRx(
        portHandler,
        servoId,
        ADDR_SCS_MIN_POSITION,
        0
      );
      
      // 设置最大位置限制为0
      let [result2, error2] = await packetHandler.write2ByteTxRx(
        portHandler,
        servoId,
        ADDR_SCS_MAX_POSITION,
        0
      );
      
      // 检查是否设置成功
      const success = (result1 === COMM_SUCCESS && result2 === COMM_SUCCESS);
      
      if (success) {
        console.log(`Successfully set servo ${servoId} to wheel mode`);
      } else {
        console.error(`Failed to set servo ${servoId} to wheel mode`, error1, error2);
      }
      
      return success;
    } catch (error) {
      console.error(`Error setting wheel mode for servo ${servoId}:`, error);
      return false;
    }
  });
}