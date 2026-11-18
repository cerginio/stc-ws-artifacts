

const container = document.getElementById('tile-container');
const breadcrumbs = document.getElementById('breadcrumbs');
const goButtons = document.getElementsByName('go-button');

let currentColorClass = null;
let selectedTilesByDepth = {};
let breadcrumbPath = [];
let rootId = 'stage1'

// Initial render
renderStage(logicTree[rootId], 'Start your journey', 1);
function choosen() {

    return logicTree.choosen[getRandom(0, logicTree.choosen.length - 1)];
    function getRandom(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

}
function updateBreadcrumbs() {
    breadcrumbs.innerHTML = '';
    breadcrumbPath.forEach((crumb, i) => {
        const span = document.createElement('span');
        span.className = 'crumb';
        span.textContent = crumb.label;
        span.onclick = () => {
            clearStagesFrom(i + 1);
            if (breadcrumbPath.length == 0) {
                setTimeout(() => {
                    rootId = 'stage2';
                    renderStage(logicTree[rootId], 'Lets try something else', 1);
                }, 1000)
            }
        };
        breadcrumbs.appendChild(span);
        if (i < breadcrumbPath.length - 1) {
            const arrow = document.createElement('span');
            arrow.className = 'arrow';
            arrow.textContent = '>>';// TODO: fontawesome
            breadcrumbs.appendChild(arrow);
        }
    });
}

function clearStagesFrom(depth) {
    const blocks = document.querySelectorAll('.stage-block');
    blocks.forEach(block => {
        if (parseInt(block.dataset.depth) >= depth) {
            block.remove();
            delete selectedTilesByDepth[block.dataset.depth];
        }
    });
    breadcrumbPath = breadcrumbPath.slice(0, depth - 1);
    updateBreadcrumbs();
    goButtons.forEach(b => b.parentElement.style.display = 'none');
    document.querySelectorAll('.tiles').forEach(tt => tt.classList.remove('hidden'))

}

function clearSelectionsAtDepth(depth) {
    if (selectedTilesByDepth[depth]) {
        selectedTilesByDepth[depth].classList.remove('selected');
        selectedTilesByDepth[depth].classList.remove(currentColorClass);
    }
}

function renderStage(options, label = 'Choose one', depth = 1) {
    clearStagesFrom(depth);

    const stageBlock = document.createElement('div');
    stageBlock.className = 'stage-block';
    stageBlock.dataset.depth = depth;

    const stageTitle = document.createElement('div');
    stageTitle.className = 'stage-label';
    stageTitle.innerHTML = `<span>Stage ${depth}: ${label}</span>`;
    const backBtn = document.createElement('button');
    backBtn.className = 'back-button';
    backBtn.textContent = '< Back';
    backBtn.onclick = () => clearStagesFrom(depth);
    if (depth > 1) stageTitle.appendChild(backBtn);
    stageBlock.appendChild(stageTitle);

    const tileGroup = document.createElement('div');
    tileGroup.className = 'tiles';

    options.forEach(option => {
        const tile = document.createElement('div');
        tile.className = 'tile';
        tile.textContent = option.label;

        tile.onclick = () => {
            clearSelectionsAtDepth(depth);
            tile.classList.add('selected');
            if (depth === 1) {
                currentColorClass = colorMap[rootId][option.id] || 'green';
            }
            tile.classList.add(currentColorClass);
            selectedTilesByDepth[depth] = tile;

            breadcrumbPath[depth - 1] = { id: option.id, label: option.label };
            updateBreadcrumbs();

            if (option.next) {
                // goButton.style.display = 'none';
                goButtons.forEach(b => b.parentElement.style.display = 'none');
                document.querySelectorAll('.tiles').forEach(tt => tt.classList.remove('hidden'))

                renderStage(option.next, `${choosen()}, "${option.label}", now...`, depth + 1);
            } else {
                clearStagesFrom(depth + 1);
                showGoButton(option);
            }
        };

        tileGroup.appendChild(tile);
    });

    stageBlock.appendChild(tileGroup);
    container.appendChild(stageBlock);
}

function showGoButton(finalChoice) {
    document.querySelectorAll('.tiles').forEach(tt => tt.classList.add('hidden'))

    goButtons.forEach(goBtn => {
        goBtn.parentElement.style.display = 'flex';
        goBtn.className = currentColorClass;
        goBtn.textContent = `${finalChoice.label}`;
        goBtn.onclick = () => {
            const finalUrlPath = breadcrumbPath.map(b => `p${breadcrumbPath.indexOf(b)}=${b.id}`).join('&');
            window.location.href = `https://storytilecraft.space?preset=${rootId}&${finalUrlPath}`;
        };
    });


}