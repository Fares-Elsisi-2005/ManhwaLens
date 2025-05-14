 const config = {
    pdfScale: 1.5,
    imageQuality: 0.7,
    debounceDelay: 100,
    tesseractLang: 'eng',
    minWordConfidence: 30,
    minWordLength: 2,
    apiUrl: 'https://api.mymemory.translated.net/get',
    stopWords: ["the", "a", "an", "is", "are", "was", "were", "has", "have", "had", "if", "and", "or", "but", "in", "on", "at", "to"],
    fallbackTranslations: {
        "this": "هذا", "episode": "حلقة", "contains": "يحتوي", "depictions": "تصويرات", "violence": "عنف",
        "that": "ذلك", "may": "قد", "upsetting": "مزعج", "for": "لـ", "some": "بعض", "readers": "قراء",
        "its": "إنه", "dokkaebi": "دوكايبي", "someone": "شخص ما", "exclaimed": "صرخ", "creature": "مخلوق",
        "sprung": "قفز", "into": "إلى", "view": "منظر", "amythical": "أسطوري", "korean": "كوري",
        "culture": "ثقافة", "similar": "مشابه", "goblin": "عفريت", "entire": "كامل"
    }
};

const elements = {
    fileInput: document.getElementById("fileInput"),
    startProcessing: document.getElementById("startProcessing"),
    container: document.getElementById("container"),
    output: document.getElementById("output"),
    loading: document.getElementById("loading"),
    saveOfflineButton: document.getElementById("saveOfflineButton")
};

let db, translationCache = new Map(), processedPagesDataForOffline = [];
if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.10.377/pdf.worker.min.js';
}

async function initIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('ManhwaDB', 1);
        request.onupgradeneeded = (event) => {
            db = event.target.result;
            db.createObjectStore('translations', { keyPath: 'word' });
            db.createObjectStore('pages', { keyPath: 'pageNum' });
        };
        request.onsuccess = () => { db = request.result; resolve(); };
        request.onerror = () => reject('Failed to initialize IndexedDB');
    });
}

async function clearIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase('ManhwaDB');
        request.onsuccess = () => {
            console.log('IndexedDB cleared');
            resolve();
        };
        request.onerror = () => reject('Failed to clear IndexedDB');
    });
}

async function cacheTranslation(word, translation) {
    return new Promise((resolve) => {
        const transaction = db.transaction(['translations'], 'readwrite');
        const store = transaction.objectStore('translations');
        store.put({ word, translation });
        transaction.oncomplete = () => resolve();
    });
}

async function getCachedTranslation(word) {
    return new Promise((resolve) => {
        const transaction = db.transaction(['translations'], 'readonly');
        const store = transaction.objectStore('translations');
        const request = store.get(word);
        request.onsuccess = () => resolve(request.result?.translation);
    });
}

async function cachePageData(pageData) {
    return new Promise((resolve) => {
        const transaction = db.transaction(['pages'], 'readwrite');
        const store = transaction.objectStore('pages');
        store.put(pageData);
        transaction.oncomplete = () => resolve();
    });
}

async function getCachedPage(pageNum) {
    return new Promise((resolve) => {
        const transaction = db.transaction(['pages'], 'readonly');
        const store = transaction.objectStore('pages');
        const request = store.get(pageNum);
        request.onsuccess = () => resolve(request.result);
    });
}

function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

function isValidBase64Image(base64Str) {
    if (!base64Str || typeof base64Str !== 'string') return false;
    const base64Regex = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/;
    return base64Regex.test(base64Str) && base64Str.length > 100;
}

const debouncedRedraw = debounce(redrawWordBoxesOnResize, config.debounceDelay);

elements.fileInput.addEventListener("change", (e) => {
    console.log("File selected");
    const file = e.target.files[0];
    if (file) {
        elements.startProcessing.style.display = 'block';
        elements.startProcessing.onclick = () => {
            console.log("Start processing clicked");
            if (file.type === "text/html") {
                console.log("Loading offline HTML file");
                loadOfflineHTML(file);
            } else {
                processFileOnline(file);
            }
        };
    } else {
        elements.startProcessing.style.display = 'none';
    }
});

async function processFileOnline(file) {
    if (!file) {
        elements.output.textContent = "الرجاء اختيار ملف.";
        console.log("No file selected");
        return;
    }
    console.log("Cleaning previous elements...");
    elements.container.innerHTML = "";
    elements.output.textContent = "";
    processedPagesDataForOffline = [];
    elements.saveOfflineButton.style.display = "none";
    elements.loading.style.display = "block";
    try {
        await clearIndexedDB();
        await initIndexedDB();
        let pagesData;
        if (file.type === "application/pdf") {
            if (typeof pdfjsLib === 'undefined') throw new Error("PDF.js not loaded");
            pagesData = await processPDF(file);
        } else if (file.type.startsWith("image/")) {
            const imgData = await readFileAsDataURL(file);
            const wordsData = await extractTextFromImage(imgData);
            pagesData = [{ imgData, wordsData, pageNum: 1 }];
        } else {
            elements.output.textContent = "نوع الملف غير مدعوم.";
            console.log("Unsupported file type");
            return;
        }
        processedPagesDataForOffline = await processExtractedWordsWithTranslation(pagesData);
        await renderPages(processedPagesDataForOffline);
        elements.saveOfflineButton.style.display = "block";
    } catch (error) {
        elements.output.textContent = `خطأ: ${error.message}`;
        console.error("Error processing file:", error);
    } finally {
        elements.loading.style.display = "none";
    }
}

async function readFileAsDataURL(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsDataURL(file);
    });
}

async function processPDF(file) {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    console.log("Loading PDF...");
    const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
    const numPages = pdf.numPages;
    console.log(`Number of pages: ${numPages}`);
    const pagesData = [];
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        console.log(`Processing page ${pageNum}...`);
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: config.pdfScale });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        console.log(`Canvas dimensions for page ${pageNum}: ${canvas.width}x${canvas.height}`);
        const context = canvas.getContext("2d");
        await page.render({ canvasContext: context, viewport }).promise;
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const isCanvasEmpty = imageData.data.every(pixel => pixel === 0);
        if (isCanvasEmpty) {
            console.warn(`Canvas for page ${pageNum} is empty`);
            elements.output.textContent += `Warning: Canvas for page ${pageNum} is empty\n`;
        }
        let imgData;
        try {
            imgData = canvas.toDataURL("image/jpeg", config.imageQuality);
            if (!isValidBase64Image(imgData)) {
                throw new Error("Invalid base64 data generated");
            }
            console.log(`Generated base64 for page ${pageNum}, length: ${imgData.length}`);
        } catch (error) {
            console.error(`Failed to generate base64 for page ${pageNum}:`, error);
            elements.output.textContent += `Error: Failed to generate image for page ${pageNum}\n`;
            imgData = '';
        }
        console.log(`Extracting text from page ${pageNum}...`);
        const wordsData = await extractTextFromImage(imgData);
        console.log(`Extracted ${wordsData.words?.length || 0} words for page ${pageNum}`);
        const pageData = { imgData, wordsData, pageNum };
        await cachePageData(pageData);
        pagesData.push(pageData);
    }
    return pagesData;
}

async function extractTextFromImage(imgData) {
    if (!imgData || !isValidBase64Image(imgData)) {
        console.error("Invalid image data provided to Tesseract");
        elements.output.textContent += `Error: Invalid image data for text extraction\n`;
        return { words: [] };
    }
    if (typeof Tesseract === 'undefined') throw new Error("Tesseract.js not loaded");
    elements.output.textContent += "Extracting text...\n";
    console.log("Starting Tesseract in Web Worker");
    try {
        const worker = new Worker(URL.createObjectURL(new Blob([`
            importScripts('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js');
            self.onmessage = async (e) => {
                const { imgData } = e.data;
                try {
                    const worker = await Tesseract.createWorker('eng', 1);
                    const { data } = await worker.recognize(imgData);
                    await worker.terminate();
                    self.postMessage({ data });
                } catch (error) {
                    self.postMessage({ error: error.message });
                }
            };
        `], { type: 'text/javascript' })));
        return new Promise((resolve, reject) => {
            worker.onmessage = (e) => {
                if (e.data.error) {
                    console.error("Tesseract error:", e.data.error);
                    resolve({ words: [] });
                } else {
                    console.log("Tesseract result:", e.data.data.text?.substring(0, 100) || "No text found");
                    elements.output.style.display = "block";
                    elements.output.textContent += `Extracted text: ${e.data.data.text?.substring(0, 100)}...\n`;
                    resolve(e.data.data);
                }
                worker.terminate();
            };
            worker.postMessage({ imgData });
        });
    } catch (error) {
        console.error("Tesseract error:", error);
        elements.output.textContent += `Error extracting text: ${error.message}\n`;
        return { words: [] };
    }
}

async function translateWord(word) {
    const lowerWord = word.toLowerCase().replace(/[^a-z]/gi, '');
    if (!lowerWord) return "غير مترجم";
    if (translationCache.has(lowerWord)) {
        console.log(`Using memory cache for ${lowerWord}`);
        return translationCache.get(lowerWord);
    }
    const cachedTranslation = await getCachedTranslation(lowerWord);
    if (cachedTranslation) {
        console.log(`Using IndexedDB cache for ${lowerWord}`);
        translationCache.set(lowerWord, cachedTranslation);
        return cachedTranslation;
    }
    if (config.fallbackTranslations[lowerWord]) {
        translationCache.set(lowerWord, config.fallbackTranslations[lowerWord]);
        await cacheTranslation(lowerWord, config.fallbackTranslations[lowerWord]);
        return config.fallbackTranslations[lowerWord];
    }
    if (navigator.onLine) {
        try {
            console.log(`Requesting translation for ${lowerWord}`);
            const response = await fetch(`${config.apiUrl}?q=${encodeURIComponent(lowerWord)}&langpair=en|ar`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            let translation = data.responseData.translatedText || "غير مترجم";
            if (translation.includes(",")) translation = translation.split(",")[0].trim();
            translationCache.set(lowerWord, translation);
            await cacheTranslation(lowerWord, translation);
            console.log(`Translated ${lowerWord}: ${translation}`);
            return translation;
        } catch (error) {
            console.error(`Translation error for ${lowerWord}:`, error);
            translationCache.set(lowerWord, "غير مترجم");
            await cacheTranslation(lowerWord, "غير مترجم");
            return "غير مترجم";
        }
    } else {
        console.log(`Offline, cannot translate ${lowerWord}`);
        translationCache.set(lowerWord, "غير مترجم (أوفلاين)");
        await cacheTranslation(lowerWord, "غير مترجم (أوفلاين)");
        return "غير مترجم (أوفلاين)";
    }
}

async function compressImage(imgData, quality = config.imageQuality, format = "image/jpeg") {
    if (!imgData || !isValidBase64Image(imgData)) {
        console.error("Invalid image data for compression");
        return imgData;
    }
    return new Promise((resolve) => {
        const img = new Image();
        img.src = imgData;
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            let compressedData;
            try {
                compressedData = canvas.toDataURL(format, quality);
                if (!isValidBase64Image(compressedData)) {
                    throw new Error("Invalid compressed base64 data");
                }
                console.log(`Image compressed, base64 length: ${compressedData.length}`);
            } catch (error) {
                console.error("Image compression failed:", error);
                compressedData = imgData;
            }
            resolve(compressedData);
        };
        img.onerror = () => {
            console.error("Failed to load image for compression");
            resolve(imgData);
        };
    });
}

async function processExtractedWordsWithTranslation(pagesData) {
    const allPagesProcessedData = [];
    for (const page of pagesData) {
        const filteredWordsData = [];
        if (page.wordsData?.words) {
            for (const wordDetails of page.wordsData.words) {
                const text = wordDetails.text?.toLowerCase().replace(/[^a-z]/gi, '');
                if (text && wordDetails.confidence >= config.minWordConfidence && text.length > config.minWordLength && !config.stopWords.includes(text)) {
                    const translation = await translateWord(text);
                    filteredWordsData.push({
                        text: wordDetails.text,
                        bbox: wordDetails.bbox,
                        translation
                    });
                }
            }
        }
        console.log(`Page ${page.pageNum}: ${page.wordsData?.words?.length || 0} raw words, ${filteredWordsData.length} words after filtering`);
        if (filteredWordsData.length === 0) {
            elements.output.textContent += `Warning: No valid words extracted for page ${page.pageNum}\n`;
        }
        const compressedImgData = await compressImage(page.imgData);
        const pageData = { imgData: compressedImgData, wordsData: filteredWordsData, pageNum: page.pageNum };
        await cachePageData(pageData);
        allPagesProcessedData.push(pageData);
    }
    return allPagesProcessedData;
}

async function renderPages(pagesToRender) {
    elements.container.innerHTML = "";
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const pageContainer = entry.target;
                const img = pageContainer.querySelector(".page-image");
                const pageNum = pageContainer.dataset.pageNum;
                const pageData = pagesToRender.find(p => p.pageNum == pageNum);
                if (pageData && img) {
                    if (pageData.wordsData?.length > 0) {
                        drawWordBoxes(pageData.wordsData, img, pageContainer);
                        console.log(`Word boxes drawn for page ${pageNum} via observer`);
                    } else {
                        console.log(`No words to draw for page ${pageNum}`);
                        elements.output.textContent += `Warning: No word boxes drawn for page ${pageNum} (empty wordsData)\n`;
                    }
                }
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });

    for (const pageData of pagesToRender) {
        if (!pageData.imgData || !isValidBase64Image(pageData.imgData)) {
            console.error(`Invalid image data for page ${pageData.pageNum}`);
            elements.output.textContent += `Error: Invalid image data for page ${pageData.pageNum}\n`;
            const errorDiv = document.createElement("div");
            errorDiv.className = "image-error";
            errorDiv.textContent = `Failed to load image for page ${pageData.pageNum}`;
            elements.container.appendChild(errorDiv);
            continue;
        }
        const pageContainer = document.createElement("div");
        pageContainer.className = "page-container";
        pageContainer.dataset.pageNum = pageData.pageNum;
        const img = document.createElement("img");
        img.className = "page-image";
        img.src = pageData.imgData;
        img.alt = `صفحة مانهوا ${pageData.pageNum}`;
        const testImg = new Image();
        testImg.src = pageData.imgData;
        testImg.onload = () => {
            pageContainer.appendChild(img);
            elements.container.appendChild(pageContainer);
            requestAnimationFrame(() => {
                if (pageData.wordsData?.length > 0) {
                    drawWordBoxes(pageData.wordsData, img, pageContainer);
                    console.log(`Word boxes drawn initially for page ${pageData.pageNum}`);
                } else {
                    console.log(`No words to draw for page ${pageData.pageNum}`);
                    elements.output.textContent += `Warning: No word boxes drawn for page ${pageData.pageNum} (empty wordsData)\n`;
                }
                observer.observe(pageContainer);
                console.log(`Page ${pageData.pageNum} set for observer`);
                // Force layout update
                pageContainer.offsetHeight;
            });
            console.log(`Page ${pageData.pageNum} image loaded successfully`);
        };
        testImg.onerror = () => {
            console.error(`Image data invalid for page ${pageData.pageNum}`);
            elements.output.textContent += `Error: Image data invalid for page ${pageData.pageNum}\n`;
            const errorDiv = document.createElement("div");
            errorDiv.className = "image-error";
            errorDiv.textContent = `Failed to load image for page ${pageData.pageNum}`;
            pageContainer.appendChild(errorDiv);
            elements.container.appendChild(pageContainer);
        };
        img.onerror = () => {
            console.error(`Failed to render image for page ${pageData.pageNum}`);
            elements.output.textContent += `Error: Failed to render image for page ${pageData.pageNum}\n`;
        };
    }
    setTimeout(() => {
        if (elements.output.textContent.length > 2000) elements.output.style.display = "none";
    }, 5000);
}

function drawWordBoxes(words, imgElement, pageContainerElement) {
    const existingWords = pageContainerElement.querySelectorAll(".word");
    existingWords.forEach(wordDiv => wordDiv.remove());
    const scaleX = imgElement.clientWidth / imgElement.naturalWidth;
    const scaleY = imgElement.clientHeight / imgElement.naturalHeight;
    console.log(`Drawing ${words.length} word boxes for page`);
    for (const word of words) {
        const box = word.bbox;
        if (!box) continue;
        const wordDiv = document.createElement("div");
        wordDiv.className = "word";
        wordDiv.style.left = `${box.x0 * scaleX}px`;
        wordDiv.style.top = `${box.y0 * scaleY}px`;
        wordDiv.style.width = `${(box.x1 - box.x0) * scaleX}px`;
        wordDiv.style.height = `${(box.y1 - box.y0) * scaleY}px`;
        pageContainerElement.appendChild(wordDiv);
        wordDiv.addEventListener("click", (e) => {
            e.stopPropagation();
            console.log(`Clicked word: ${word.text}`);
            showTooltip(wordDiv, word.text, word.translation, e.clientX, e.clientY);
        });
    }
}

function showTooltip(wordDiv, originalWord, translation, x, y) {
    const existingTooltip = document.querySelector(".tooltip");
    if (existingTooltip) existingTooltip.remove();
    const tooltip = document.createElement("div");
    tooltip.className = "tooltip";
    tooltip.innerHTML = `
        <div>
            <strong>الكلمة:</strong> ${originalWord}<br>
            <strong>الترجمة:</strong> ${translation}<br>
            <button onclick="pronounceWord('${originalWord.replace(/[^a-zA-Z0-9\s]/g, '')}')">نطق الكلمة</button>
        </div>`;
    document.body.appendChild(tooltip);
    const rect = tooltip.getBoundingClientRect();
    let left = x + 15, top = y + 15;
    if (left + rect.width > window.innerWidth) left = x - rect.width - 15;
    if (top + rect.height > window.innerHeight) top = y - rect.height - 15;
    if (left < 0) left = 5;
    if (top < 0) top = 5;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.style.display = "block";
    document.addEventListener("click", function closeTooltip(event) {
        if (!tooltip.contains(event.target) && event.target !== wordDiv) {
            tooltip.remove();
            document.removeEventListener("click", closeTooltip, true);
        }
    }, true);
}

window.pronounceWord = function (wordToPronounce) {
    if (!window.speechSynthesis) {
        alert("ميزة النطق غير مدعومة في متصفحك.");
        return;
    }
    const utterance = new SpeechSynthesisUtterance(wordToPronounce);
    utterance.lang = "en-US";
    speechSynthesis.speak(utterance);
    console.log(`Pronouncing: ${wordToPronounce}`);
};

elements.container.addEventListener("dragstart", (e) => {
    if (e.target.classList.contains("page-image")) e.preventDefault();
});

window.addEventListener("resize", () => {
    console.log("Window resized, debouncing redraw...");
    debouncedRedraw();
});

function redrawWordBoxesOnResize() {
    const dataToRedraw = processedPagesDataForOffline.length > 0 ? processedPagesDataForOffline : (document.getElementById('offlineData').textContent ? JSON.parse(document.getElementById('offlineData').textContent) : []);
    if (!dataToRedraw || dataToRedraw.length === 0) return;
    for (const pageData of dataToRedraw) {
        const pageContainer = elements.container.querySelector(`.page-container[data-page-num="${pageData.pageNum}"]`);
        const img = pageContainer?.querySelector(".page-image");
        if (img && pageContainer && pageData.wordsData?.length > 0) {
            requestAnimationFrame(() => {
                drawWordBoxes(pageData.wordsData, img, pageContainer);
                console.log(`Redrawn boxes for page ${pageData.pageNum}`);
            });
        }
    }
}

elements.saveOfflineButton.addEventListener("click", () => {
    if (processedPagesDataForOffline.length > 0) {
        generateAndDownloadOfflineHTML(processedPagesDataForOffline);
    } else {
        alert("لا توجد بيانات لمعالجتها وحفظها.");
    }
});

function generateAndDownloadOfflineHTML(dataToSave) {
    for (const page of dataToSave) {
        if (!page.imgData || !isValidBase64Image(page.imgData)) {
            console.error(`Invalid image data for page ${page.pageNum} in offline HTML`);
            elements.output.textContent += `Error: Invalid image data for page ${page.pageNum} in offline HTML\n`;
        } else {
            console.log(`Offline HTML page ${page.pageNum} imgData length: ${page.imgData.length}`);
        }
        if (!page.wordsData || page.wordsData.length === 0) {
            console.warn(`No words data for page ${page.pageNum} in offline HTML`);
            elements.output.textContent += `Warning: No word boxes will be available for page ${page.pageNum} in offline HTML\n`;
        }
    }
    const htmlContent = `
<!DOCTYPE html>
<html lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>مانهوا (أوفلاين) - ${new Date().toLocaleDateString()}</title>
    <style>
        body{font-family:Arial,sans-serif;text-align:center;background-color:#f4f4f4;margin:0}
        #container{display:flex;flex-direction:column;align-items:center;margin:20px}
        .page-container{position:relative;margin-bottom:20px;width:fit-content;opacity:1}
        .page-container.hidden{opacity:0;transition:opacity 0.5s}
        .page-image{max-width:100%;display:block;position:relative;z-index:1;visibility:visible}
        .word{position:absolute;border:2px solid rgb(0 0 255 / 9%);background:rgb(0 0 255 / 1%);cursor:pointer;z-index:10;pointer-events:auto}
        .tooltip{position:fixed;background:#333;color:#fff;padding:10px;border-radius:5px;z-index:1000;max-width:200px;text-align:left;display:none}
        .tooltip button{margin-top:5px;padding:5px 10px;font-size:12px;background:#007bff;color:#fff;border:none;border-radius:3px;cursor:pointer}
        .image-error{display:block;color:red;font-size:16px;margin:10px}
    </style>
</head>
<body>
    <h1>مانهوا للقراءة أوفلاين</h1>
    <p>تم إنشاؤه في: ${new Date().toLocaleString()}</p>
    <div id="container_offline"></div>
    <div id="offlineDataStorage" style="display:none;">${JSON.stringify(dataToSave)}</div>
    <script>
        const offlineContainer = document.getElementById("container_offline");
        const storedDataElement = document.getElementById("offlineDataStorage");
        let offlinePagesData = [];
        try {
            offlinePagesData = JSON.parse(storedDataElement.textContent);
        } catch (e) {
            console.error("Failed to parse offline data:", e);
            offlineContainer.innerHTML = "<p>خطأ في تحميل بيانات المانهوا.</p>";
        }
        function isValidBase64Image(base64Str) {
            if (!base64Str || typeof base64Str !== 'string') return false;
            const base64Regex = /^data:image\\/(jpeg|png);base64,[A-Za-z0-9+\\/=]+$/;
            return base64Regex.test(base64Str) && base64Str.length > 100;
        }
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const pageContainer = entry.target;
                    const img = pageContainer.querySelector(".page-image");
                    const pageNum = pageContainer.dataset.pageNum;
                    const pageData = offlinePagesData.find(p => p.pageNum == pageNum);
                    if (pageData && img) {
                        if (pageData.wordsData?.length > 0) {
                            drawWordBoxesOffline(pageData.wordsData, img, pageContainer);
                            console.log(\`Word boxes drawn for offline page \${pageNum} via observer\`);
                        } else {
                            console.log(\`No words to draw for offline page \${pageNum}\`);
                        }
                    }
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.1 });
        function drawWordBoxesOffline(words, imgElement, pageContainerElement) {
            const existingWords = pageContainerElement.querySelectorAll(".word");
            existingWords.forEach(wordDiv => wordDiv.remove());
            const scaleX = imgElement.clientWidth / imgElement.naturalWidth;
            const scaleY = imgElement.clientHeight / imgElement.naturalHeight;
            console.log(\`Drawing \${words.length} word boxes for offline page\`);
            for (const word of words) {
                const box = word.bbox;
                if (!box) continue;
                const wordDiv = document.createElement("div");
                wordDiv.className = "word";
                wordDiv.style.left = \`\${box.x0 * scaleX}px\`;
                wordDiv.style.top = \`\${box.y0 * scaleY}px\`;
                wordDiv.style.width = \`\${(box.x1 - box.x0) * scaleX}px\`;
                wordDiv.style.height = \`\${(box.y1 - box.y0) * scaleY}px\`;
                pageContainerElement.appendChild(wordDiv);
                wordDiv.addEventListener("click", (e) => {
                    e.stopPropagation();
                    showTooltipOffline(wordDiv, word.text, word.translation, e.clientX, e.clientY);
                });
            }
        }
        function showTooltipOffline(wordDiv, originalWord, translation, x, y) {
            const existingTooltip = document.querySelector(".tooltip");
            if (existingTooltip) existingTooltip.remove();
            const tooltip = document.createElement("div");
            tooltip.className = "tooltip";
            tooltip.innerHTML = \`<div><strong>الكلمة:</strong> \${originalWord}<br><strong>الترجمة:</strong> \${translation}<br><button onclick="pronounceWordOffline('\${originalWord.replace(/[^a-zA-Z0-9\\\\s]/g, '')}')">نطق الكلمة</button></div>\`;
            document.body.appendChild(tooltip);
            const rect = tooltip.getBoundingClientRect();
            let left = x + 15, top = y + 15;
            if (left + rect.width > window.innerWidth) left = x - rect.width - 15;
            if (top + rect.height > window.innerHeight) top = y - rect.height - 15;
            if (left < 0) left = 5;
            if (top < 0) top = 5;
            tooltip.style.left = \`\${left}px\`;
            tooltip.style.top = \`\${top}px\`;
            tooltip.style.display = "block";
            document.addEventListener("click", function closeTT(event) {
                if (!tooltip.contains(event.target) && event.target !== wordDiv) {
                    tooltip.remove();
                    document.removeEventListener("click", closeTT, true);
                }
            }, true);
        }
        window.pronounceWordOffline = function (wordToPronounce) {
            if (!window.speechSynthesis) {
                alert("ميزة النطق غير مدعومة.");
                return;
            }
            const utterance = new SpeechSynthesisUtterance(wordToPronounce);
            utterance.lang = "en-US";
            speechSynthesis.speak(utterance);
        };
        function renderOfflinePages(pagesToRender) {
            offlineContainer.innerHTML = "";
            for (const pageData of pagesToRender) {
                if (!pageData.imgData || !isValidBase64Image(pageData.imgData)) {
                    console.error(\`Invalid image data for page \${pageData.pageNum}\`);
                    offlineContainer.innerHTML += \`<p class="image-error">Error: Invalid image data for page \${pageData.pageNum}</p>\`;
                    continue;
                }
                const pageContainer = document.createElement("div");
                pageContainer.className = "page-container";
                pageContainer.dataset.pageNum = pageData.pageNum;
                const img = document.createElement("img");
                img.className = "page-image";
                img.src = pageData.imgData;
                img.alt = \`صفحة مانهوا \${pageData.pageNum}\`;
                const testImg = new Image();
                testImg.src = pageData.imgData;
                testImg.onload = () => {
                    pageContainer.appendChild(img);
                    offlineContainer.appendChild(pageContainer);
                    requestAnimationFrame(() => {
                        if (pageData.wordsData?.length > 0) {
                            drawWordBoxesOffline(pageData.wordsData, img, pageContainer);
                            console.log(\`Word boxes drawn initially for offline page \${pageData.pageNum}\`);
                        } else {
                            console.log(\`No words to draw for offline page \${pageData.pageNum}\`);
                        }
                        observer.observe(pageContainer);
                        console.log(\`Offline page \${pageData.pageNum} set for observer\`);
                        // Force layout update
                        pageContainer.offsetHeight;
                    });
                    console.log(\`Offline page \${pageData.pageNum} image loaded\`);
                };
                testImg.onerror = () => {
                    console.error(\`Invalid image data for offline page \${pageData.pageNum}\`);
                    offlineContainer.innerHTML += \`<p class="image-error">Error: Invalid image data for page \${pageData.pageNum}</p>\`;
                };
                img.onerror = () => console.error(\`Failed to render image for offline page \${pageData.pageNum}\`);
            }
        }
        function redrawWordBoxesOnResizeOffline() {
            if (!offlinePagesData || offlinePagesData.length === 0) return;
            for (const pageData of offlinePagesData) {
                const pageC = offlineContainer.querySelector(\`.page-container[data-page-num="\${pageData.pageNum}"]\`);
                const imgEl = pageC?.querySelector(".page-image");
                if (imgEl && pageC && pageData.wordsData?.length > 0) {
                    requestAnimationFrame(() => {
                        drawWordBoxesOffline(pageData.wordsData, imgEl, pageC);
                        console.log(\`Redrawn boxes for offline page \${pageData.pageNum}\`);
                    });
                }
            }
        }
        window.addEventListener("resize", redrawWordBoxesOnResizeOffline);
        document.addEventListener("DOMContentLoaded", () => {
            if (offlinePagesData.length > 0) renderOfflinePages(offlinePagesData);
            else offlineContainer.innerHTML = "<p>لم يتم العثور على بيانات مانهوا مخزنة.</p>";
        });
    </script>
</body>
</html>`;
    const blob = new Blob([htmlContent], { type: "text/html" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `manhwa_offline_${Date.now()}.html`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    console.log("Offline HTML generated");
    elements.output.textContent += "\nتم إنشاء ملف HTML للقراءة Offline.";
}

async function readFileAsArrayBuffer(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(new Uint8Array(event.target.result));
        reader.readAsArrayBuffer(file);
    });
}

function loadOfflineHTML(htmlFile) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const htmlString = e.target.result;
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, "text/html");
        const dataScript = doc.getElementById("offlineDataStorage");
        if (dataScript && dataScript.textContent) {
            try {
                const loadedOfflineData = JSON.parse(dataScript.textContent);
                processedPagesDataForOffline = loadedOfflineData;
                document.getElementById('offlineData').textContent = dataScript.textContent;
                elements.container.innerHTML = "<h2>تم تحميل بيانات الأوفلاين.</h2><p>أعد تحميل الصفحة أو قم بتشغيل العرض يدويًا إذا لزم الأمر.</p>";
                renderPages(loadedOfflineData);
                elements.output.textContent = "تم تحميل بيانات المانهوا من ملف HTML.";
                elements.saveOfflineButton.style.display = "none";
                console.log("Offline HTML data loaded");
            } catch (err) {
                console.error("Failed to parse offline HTML data:", err);
                elements.output.textContent = "فشل في قراءة البيانات من ملف HTML.";
            }
        } else {
            elements.output.textContent = "ملف HTML المحمل لا يحتوي على بيانات مانهوا متوقعة.";
        }
    };
    reader.readAsText(htmlFile);
}