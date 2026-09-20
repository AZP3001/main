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

## Spectator Mode
Click any car on the track to pin the telemetry panel and sensor overlay to it — it stays highlighted until it crashes or you click empty space / hit "Release". With nothing selected, the panel auto-follows whichever car currently has the best fitness.

## Track Editor
### How a track is built
A track is a closed centre line plus a width. The road surface is everything within that width of the centre line — the same shape you'd get by stroking the line with a fat round pen — and the barriers are traced along the outside edge of exactly that shape, as one continuous wall per side. So the road is the same width the whole way round, the walls always sit on the edge of the asphalt, and where a track crosses or runs into itself the two bits of road simply join up instead of leaving stray walls in the middle of the road.

Each point on the path is a turn, and turns are real circular arcs:
* **Rounded:** an arc of the radius you set on the slider.
* **Corner:** the tightest arc the track width still allows — sharp, but never so sharp that nothing fits through it.

A turn is never allowed to be tighter than the road is wide, and neighbouring turns share out the straight between them, so putting two points close together softens both instead of kinking the road.

Besides placing points by hand, the editor has three ways to build a track:
* **Draw:** switch to the Draw tab and drag a loop directly on the canvas — it's simplified into an editable path automatically.
* **Import from Image:** upload a PNG/JPG (a hand-drawn loop or a photo of a track layout) and it's analyzed (thresholded, skeletonized, traced) into a starting track for you to refine.
* **Duplicate:** clone the currently-selected track as a starting point for a variant.

Tracks you create are saved in your browser (localStorage) and are still there next time you load the page, alongside your last-used sim/physics settings.

### Publishing a track for everyone
Hit **Publish** while editing a track to open a prefilled GitHub issue with the track's data. A GitHub Actions workflow validates the submission and opens a pull request adding it to `tracks.js` — once a maintainer merges it, it's live for everyone. No account/backend setup needed beyond GitHub itself.

## Keyboard Shortcuts
* **Space:** Play / Pause
* **H:** Toggle Hyper Mode
* **R:** Reset
* **Esc:** Cancel track editing, or release a manual spectator selection

## Performance
Neural network weights are stored as flat `Float32Array`s (not arrays-of-arrays), which makes copying/mutating brains and shipping a generation to the Web Worker pool considerably cheaper — the biggest lever on how many generations per second you get out of Hyper Mode.
