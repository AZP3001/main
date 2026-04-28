# AI RaceTrack Evolution    
[*To Simulation*](https://azp3001.github.io/main/)

A 2D Race-Track simulation where AIs learn to navigate a racetrack through evolution algorithms.

## Overview
The simulation puts a population of cars onto a track. Each car is controlled by a neural network wich processes "lidar" data to produce continuous control outputs. Only the best performers pass their "genes" (weights) to the next generation.

### The Learning Process
The AIs have four primary control axes. To allow for more precise controls the axes are **analog (0-100%)**, allowing for more precise & smooth driving:
* **Gas**
* **Brake**
* **Steer Left**
* **Steer Right**

---

## Configuration & Settings
Fine-tune the simulation and the learning process using the built-in settings.

### AI & Evolutionary Parameters
* **Pop Size:** The number of agents generated per generation.
* **Elite Clones:** Number of top-performing agents preserved exactly for the next generation (prevents regression).
* **Mutation Rate:** The probability and intensity of random changes to the neural weights.
* **Hidden Layers:** Adjust the complexity of the AI's "brain" by changing the number of internal neurons.
* **Initial TTL (Time-To-Live):** A countdown timer for each agent. Agents must reach checkpoints to reset this timer, ensuring they don't just sit still.
* **Target Laps:** Defines the goalpost for a successful generation before moving to the next stage of evolution.

### Physics Engine
* **Max Speed:** Maximum Speed of the Cars.
* **Acceleration:** Acceleration to the Max Speed.
* **Turn Speed:** Controls how quickly the cars are able to turn.
* **Grip:** Doesnt do much, introduced as a fix for turning Physics.

### Simulation Control
* **Simulation Speed:** Adjust the simulation speed.
* **Hyper Mode:** Simulates as fast as your PC allows. (Doesn't render for even faster Processing)

---
*Developed by [AZP3001](https://github.com/AZP3001)*
