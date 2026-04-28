**AI RaceTrack Evolution**   [Launch](https://azp3001.github.io/main/)

A sophisticated 2D simulation where autonomous agents (AIs) learn to navigate a complex racetrack through evolutionary algorithms. Starting with zero knowledge, these agents evolve over generations to master speed, precision, and lap efficiency.

## Overview

The simulation drops a population of cars onto a track. Each car is controlled by a neural network that processes environmental data to produce continuous control outputs. Through a process of natural selection, only the best performers pass their "genes" (weights) to the next generation.

### The Learning Process
The AI agents have four primary control axes. Unlike simple binary inputs, these are **analog (0-100%)**, allowing for nuanced driving:
* **Gas:**
* **Brake:**
* **Steer Left:**
* **Steer Right:**

---

## Configuration & Settings

Fine-tune the simulation and the evolutionary process using the built-in control panel.

### AI & Evolutionary Parameters
* **Pop Size:** The number of agents generated per generation.
* **Elite Clones:** Number of top-performing agents preserved exactly for the next generation (prevents regression).
* **Mutation Rate:** The probability and intensity of random changes to the neural weights.
* **Hidden Layers:** Adjust the complexity of the AI's "brain" by changing the number of internal neurons.
* **Initial TTL (Time-To-Live):** A countdown timer for each agent. Agents must reach checkpoints to reset this timer, ensuring they don't just sit still.
* **Target Laps:** Defines the goalpost for a successful generation before moving to the next stage of evolution.

### Physics Engine
* **Max Speed:** The velocity ceiling for all vehicles.
* **Acceleration:** Dictates how quickly cars reach their top speed.
* **Turn Speed:** Controls the rotational agility of the vehicles.
* **Grip:** Manages friction and handling stability to ensure realistic cornering.

### Simulation Control
* **Simulation Speed:** Adjust the playback speed to observe behaviors in detail.
* **Hyper Mode:** Skip rendering or maximize processing to evolve generations at lightning speed.

---

## Getting Started

1.  **Visit the Live Page:** [Launch Simulation](https://azp3001.github.io/main/)
2.  **Observe:** Watch the first generation (Gen 0) struggle and fail.
3.  **Optimize:** Increase the **Mutation Rate** if they are stuck, or increase **Pop Size** to find a "genius" driver faster.
4.  **Evolve:** Sit back and watch the AI optimize its racing line over time.

---

## Tech Stack
* **Language:** JavaScript / HTML5 Canvas
* **Logic:** Genetic Algorithms & Neural Networks
* **Deployment:** GitHub Pages

---

## Contributing
Contributions are welcome! If you have ideas for better fitness functions, new track layouts, or advanced physics (like drifting or collisions), feel free to fork the repo and submit a PR.

---
*Developed by [AZP3001](https://github.com/AZP3001)*
