const whiteboard = document.getElementById("whiteboard");
const controls = document.getElementById("controls");

// GUI control
const colourButton = document.getElementById("PencilColour");
const shapeButton = document.getElementById("SelectShape");
const savePNGButton = document.getElementById("saveButton");
const redrawButton = document.getElementById("redrawButton");
const fontSizeButton = document.getElementById("FontSize");
const context = whiteboard.getContext("2d");

// Window size
whiteboard.style.top = 0 + controls.offsetHeight;
whiteboard.height = window.innerHeight - controls.offsetHeight;
whiteboard.width = window.innerWidth;

// State management
const state = {
    color: "#000000",
    font: "16px sans",
    lineWidth: 10,
    lineCap: "round",
    pressedDown: false,
    fromX: null,
    fromY: null,
};

// Helper functions for state
function updateState(property, value) {
    state[property] = value;
}

function syncStateWithGUI() {
    state.color = getColor();
    state.font = getFont();
}

function getFont() {
    return fontSizeButton.value + "px sans";
}

function getColor() {
    return colourButton.value;
}

// Sync GUI controls with state
["change", "input"].forEach((event) => {
    colourButton.addEventListener(event, () => updateState("color", getColor()));
    fontSizeButton.addEventListener(event, () => updateState("font", getFont()));
});

// Selecting tool
const Drawer = {};
var io;

function getDrawer() {
    switch (shapeButton.value) {
        case "Line":
            return Drawer.line;
        case "Circle":
            return Drawer.circle;
        case "Rectangle":
            return Drawer.rect;
        case "Text":
            return Drawer.text;
    }
}

let img = null;

function checkSave(inProgress) {
    if (img) {
        context.putImageData(img, 0, 0);
        if (!inProgress) img = null;
    } else if (inProgress) {
        img = context.getImageData(0, 0, whiteboard.width, whiteboard.height);
    }
}

function contextBegin({ color, font }) {
    context.beginPath();

    if (color) {
        context.fillStyle = color;
        context.strokeStyle = color;
    }

    if (font) {
        context.font = font;
    }
}

const eventHandler = {
    drawText: function ({ x, y, text, color, font }) {
        contextBegin({ color, font });
        context.fillText(text, x, y);
    },

    drawLine: function ({ x, y, fromX, fromY, color }) {
        contextBegin({ color });

        context.lineWidth = state.lineWidth;
        context.lineCap = state.lineCap;
        context.moveTo(fromX, fromY);
        context.lineTo(x, y);
        context.stroke();
    },

    drawRect: function ({ x, y, fromX, fromY, color, inProgress }) {
        contextBegin({ color });
        checkSave(inProgress);

        const width = x - fromX;
        const height = y - fromY;
        context.strokeRect(fromX, fromY, width, height);
    },

    drawCircle: function ({ x, y, fromX, fromY, color, inProgress }) {
        contextBegin({ color });
        checkSave(inProgress);

        context.lineWidth = state.lineWidth;
        context.lineCap = state.lineCap;

        context.beginPath();
        context.moveTo(fromX, fromY + (y - fromY) / 2);

        // Draws top half of circle
        context.bezierCurveTo(
            fromX,
            fromY,
            x,
            fromY,
            x,
            fromY + (y - fromY) / 2
        );

        // Draws bottom half of circle
        context.bezierCurveTo(x, y, fromX, y, fromX, fromY + (y - fromY) / 2);

        context.stroke();
    },

    clear: function () {
        context.clearRect(0, 0, whiteboard.width, whiteboard.height);
    },
};

function emit(name, args) {
    eventHandler[name](args);
    if (!args.inProgress) io.emit(name, args);
}

Drawer.line = {
    mousedown: function ({ x, y }) {
        state.pressedDown = true;
        state.fromX = x;
        state.fromY = y;
    },

    mouseup: function () {
        state.pressedDown = false;
    },

    mousemove: function ({ x, y }) {
        if (!state.pressedDown) return;

        emit("drawLine", {
            fromX: state.fromX,
            fromY: state.fromY,
            color: state.color,
            x,
            y,
        });

        state.fromX = x;
        state.fromY = y;
    },
};

function shapeDrawer(name) {
    name = `draw${name}`;
    return {
        mousedown: function ({ x, y }) {
            state.fromX = x;
            state.fromY = y;
            state.pressedDown = true;
        },

        mouseup: function ({ x, y }) {
            state.pressedDown = false;
            emit(name, {
                fromX: state.fromX,
                fromY: state.fromY,
                color: state.color,
                font: state.font,
                inProgress: false,
                x,
                y,
            });
        },

        mousemove: function ({ x, y }) {
            if (!state.pressedDown) return;
            emit(name, {
                fromX: state.fromX,
                fromY: state.fromY,
                color: state.color,
                font: state.font,
                inProgress: true,
                x,
                y,
            });
        },
    };
}

Drawer.rect = shapeDrawer("Rect");
Drawer.circle = shapeDrawer("Circle");
Drawer.text = {
    mousedown: function ({ x, y }) {
        const text = prompt("Enter text");
        emit("drawText", {
            x,
            y,
            text,
            color: state.color,
            font: state.font,
        });
    },
};

function onEvent(event, pos) {
    getDrawer()?.[event]?.(pos);
}

// Main
window.onload = function () {
    io = io.connect("http://localhost:3000");
    for (const [key, value] of Object.entries(eventHandler)) {
        io.on(key, value);
    }

    // Set background to be white
    context.fillStyle = "white";
    context.fillRect(0, 0, whiteboard.width, whiteboard.height);

    // Save image
    savePNGButton.addEventListener("click", () => {
        const image = whiteboard
            .toDataURL("image/png")
            .replace("image/png", "image/octet-stream");
        window.location.href = image;
    });

    redrawButton.addEventListener("click", () => emit("clear", {}));

    function coord(e) {
        return {
            x: e.pageX - whiteboard.offsetLeft,
            y: e.pageY - whiteboard.offsetTop,
        };
    }

    ["mousedown", "mouseup", "mousemove"].forEach((name) =>
        whiteboard.addEventListener(name, (event) =>
            onEvent(name, coord(event))
        )
    );
};
