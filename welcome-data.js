

const colorMap = {
    stage1: {
        "learn-draw": "green",
        "draw-alone": "blue",
        "draw-with-parent": "orange",
        "draw-with-therapist": "purple"
    },
    stage2: {
        "learn-draw": "green",
        "draw-alone": "blue",
        "draw-with-parent": "orange",
        "draw-with-therapist": "purple"
    },
};
const logicTree = {
    choosen: [
        'Great choice!', 'Awesome!', 'Nice one!',
        'Perfect!', 'Well done!', 'Let’s keep going!',
        'Good pick!', 'Sounds great!', 'You’re on a roll!',
        'Excellent!', 'Lovely choice!', 'Super!', 'Cool!',
        'Yup, good one!', 'That works!', 'Alright!',
        'Fantastic!', 'You got it!', 'Onward!',
        'Let’s continue!', 'Yes, that’s it!', 'All right, next up!',
        'Ready for the next step?', 'Let’s go!', 'Right on!',
        'Yay! Great choice!', 'Awesome pick!', 'Cool, let’s go!',
        'Nice one!', 'You got it!', 'Woohoo!',
        'Ready for the next step!', 'Let’s keep going!', 'Super choice!',
        'Well done!', 'That’s fun!', 'Good one!', 'Sweet!',
        'Alrighty!', 'Okie dokie!', 'Boom, next one!',
        'Yup, let’s do this!', 'Great choice!', 'I like that one.',
        'Good direction.', 'You’re doing well.', 'Nice decision!',
        'That makes sense.', 'Let’s continue.', 'On to the next one.',
        'Good step forward.',
        'Let’s keep going together.', 'I’m with you.', 'One step at a time.',
        'Thanks for choosing!', 'I appreciate your choice.', 'Shall we move on?',
        'Choosen', 'OK', 'Great', 'Roger that', 'Perfect', 'Excellent',
        'That’s a great choice', 'That makes sense', 'Great decision',
    ],

    "stage2": [
        {
            "id": "learn-draw",
            "label": "I learn to draw",
            "next": [
                {
                    "id": "mosaic-drawing",
                    "label": "Mosaic drawing",
                    "next": [
                        { "id": "shapes-with-emotion", "label": "Draw emotions through shapes" },
                        { "id": "shapes-to-characters", "label": "Make characters from shapes" }
                    ]
                },
                {
                    "id": "spots-drawing",
                    "label": "Spots drawing",
                    "next": [
                        { "id": "copy-favorite", "label": "Copy your favorite characters" },
                        { "id": "trace-and-change", "label": "Trace then remix" }
                    ]
                }
            ]
        },
        {
            "id": "draw-alone",
            "label": "I draw alone",
            "next": [
                {
                    "id": "alone-express",
                    "label": "I draw to express myself",
                    "next": [
                        { "id": "express-journal", "label": "Art journal feelings" },
                        { "id": "express-dream", "label": "Draw dreams & thoughts" }
                    ]
                },
                {
                    "id": "alone-fun",
                    "label": "Just for fun",
                    "next": [
                        { "id": "fun-doodle", "label": "Silly doodles" },
                        { "id": "fun-imaginary", "label": "Imaginary places" }
                    ]
                }
            ]
        },
        {
            "id": "draw-with-parent",
            "label": "I draw with parent",
            "next": [
                {
                    "id": "parent-story",
                    "label": "We tell stories together",
                    "next": [
                        { "id": "story-monsters", "label": "Monster world" },
                        { "id": "story-family", "label": "Our family as superheroes" }
                    ]
                },
                {
                    "id": "parent-learn",
                    "label": "They help me learn",
                    "next": [
                        { "id": "learn-color-mix", "label": "Mixing colors" },
                        { "id": "learn-shadow", "label": "Light and shadow" }
                    ]
                }
            ]
        },
        {
            "id": "draw-with-therapist",
            "label": "I draw story with therapist",
            "next": [
                {
                    "id": "therapy-safe-space",
                    "label": "Creating a safe space",
                    "next": [
                        { "id": "safe-cave", "label": "Draw your cave or shelter" },
                        { "id": "safe-animal", "label": "Draw a protector animal" }
                    ]
                },
                {
                    "id": "therapy-journey",
                    "label": "My emotional journey",
                    "next": [
                        { "id": "journey-map", "label": "Emotional map" },
                        { "id": "journey-monster", "label": "Face a fear monster" }
                    ]
                }
            ]
        }
    ],

    "stage1": [
        {
            "id": "learn-draw",
            "label": "I learn to draw",
            "next": [
                {
                    "id": "learn-basic-shapes",
                    "label": "Basic shapes & coloring",
                    "next": [
                        { "id": "shapes-with-emotion", "label": "Draw emotions through shapes" },
                        { "id": "shapes-to-characters", "label": "Make characters from shapes" }
                    ]
                },
                {
                    "id": "learn-copying",
                    "label": "I like copying stuff",
                    "next": [
                        { "id": "copy-favorite", "label": "Copy your favorite characters" },
                        { "id": "trace-and-change", "label": "Trace then remix" }
                    ]
                }
            ]
        },
        {
            "id": "draw-alone",
            "label": "I draw alone",
            "next": [
                {
                    "id": "alone-express",
                    "label": "I draw to express myself",
                    "next": [
                        { "id": "express-journal", "label": "Art journal feelings" },
                        { "id": "express-dream", "label": "Draw dreams & thoughts" }
                    ]
                },
                {
                    "id": "alone-fun",
                    "label": "Just for fun",
                    "next": [
                        { "id": "fun-doodle", "label": "Silly doodles" },
                        { "id": "fun-imaginary", "label": "Imaginary places" }
                    ]
                }
            ]
        },
        {
            "id": "draw-with-parent",
            "label": "I draw with parent",
            "next": [
                {
                    "id": "parent-story",
                    "label": "We tell stories together",
                    "next": [
                        { "id": "story-monsters", "label": "Monster world" },
                        { "id": "story-family", "label": "Our family as superheroes" }
                    ]
                },
                {
                    "id": "parent-learn",
                    "label": "They help me learn",
                    "next": [
                        { "id": "learn-color-mix", "label": "Mixing colors" },
                        { "id": "learn-shadow", "label": "Light and shadow" }
                    ]
                }
            ]
        },
        {
            "id": "draw-with-therapist",
            "label": "I draw story with therapist",
            "next": [
                {
                    "id": "therapy-safe-space",
                    "label": "Creating a safe space",
                    "next": [
                        { "id": "safe-cave", "label": "Draw your cave or shelter" },
                        { "id": "safe-animal", "label": "Draw a protector animal" }
                    ]
                },
                {
                    "id": "therapy-journey",
                    "label": "My emotional journey",
                    "next": [
                        { "id": "journey-map", "label": "Emotional map" },
                        { "id": "journey-monster", "label": "Face a fear monster" }
                    ]
                }
            ]
        }
    ]
};