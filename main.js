 const fileInput=document.getElementById("fileInput"),container=document.getElementById("container"),output=document.getElementById("output"),loading=document.getElementById("loading"),saveOfflineButton=document.getElementById("saveOfflineButton");
        if(typeof pdfjsLib!=='undefined'){pdfjsLib.GlobalWorkerOptions.workerSrc=`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.10.377/pdf.worker.min.js`;}
        const stopWords=["the","a","an","is","are","was","were","has","have","had","if","and","or","but","in","on","at","to"];
        const fallbackTranslations={"this":"هذا","episode":"حلقة","contains":"يحتوي","depictions":"تصويرات","violence":"عنف","that":"ذلك","may":"قد","upsetting":"مزعج","for":"لـ","some":"بعض","readers":"قراء","its":"إنه","dokkaebi":"دوكايبي","someone":"شخص ما","exclaimed":"صرخ","creature":"مخلوق","sprung":"قفز","into":"إلى","view":"منظر","amythical":"أسطوري","korean":"كوري","culture":"ثقافة","similar":"مشابه","goblin":"عفريت","entire":"كامل"};
        const translationCache=new Map();
        let processedPagesDataForOffline=[];

        fileInput.addEventListener("change",async e=>{console.log("تم اختيار ملف جديد");const file=e.target.files[0];if(file){if(file.type==="text/html"){console.log("محاولة تحميل ملف HTML للقراءة Offline");loadOfflineHTML(file)}else{await processFileOnline(file)}}});

        async function processFileOnline(file){
            if(!file){output.textContent="الرجاء اختيار ملف.";console.log("لم يتم اختيار ملف");return}
            console.log("تنظيف العناصر السابقة...");container.innerHTML="";output.textContent="";processedPagesDataForOffline=[];saveOfflineButton.style.display="none";
            if(loading)loading.style.display="block";
            try{
                let pagesData;
                if(file.type==="application/pdf"){
                    if(typeof pdfjsLib==='undefined'){alert("مكتبة PDF.js غير متاحة. لا يمكن معالجة ملف PDF أوفلاين بدون معالجة مسبقة.");throw new Error("PDF.js not loaded")}
                    pagesData=await processPDF(file);
                }else if(file.type.startsWith("image/")){
                    const imgData=await new Promise(resolve=>{const reader=new FileReader();reader.onload=e=>resolve(e.target.result);reader.readAsDataURL(file)});
                    const wordsData=await extractTextFromImage(imgData);
                    pagesData=[{imgData,wordsData,pageNum:1}];
                }else{
                    output.textContent="نوع الملف غير مدعوم. الرجاء اختيار صورة أو ملف PDF.";console.log("نوع الملف غير مدعوم");if(loading)loading.style.display="none";return
                }
                processedPagesDataForOffline=await processExtractedWordsWithTranslation(pagesData);
                await renderPages(processedPagesDataForOffline);
                saveOfflineButton.style.display="block";
            }catch(error){
                output.textContent=`خطأ: ${error.message}`;console.error("خطأ في معالجة الملف:",error);
            }finally{
                if(loading)loading.style.display="none";
            }
        }

        async function processPDF(file){
            const reader=new FileReader();
            return new Promise((resolve,reject)=>{
                reader.onload=async event=>{
                    try{
                        console.log("جارٍ تحميل ملف PDF...");
                        const typedArray=new Uint8Array(event.target.result);
                        const pdf=await pdfjsLib.getDocument(typedArray).promise;
                        const numPages=pdf.numPages;
                        console.log(`عدد الصفحات: ${numPages}`);
                        const pagesDataPromises=[];
                        for(let pageNum=1;pageNum<=numPages;pageNum++){
                            pagesDataPromises.push((async()=>{
                                console.log(`معالجة الصفحة ${pageNum}...`);
                                const page=await pdf.getPage(pageNum);
                                const viewport=page.getViewport({scale:1.5});
                                const canvas=document.createElement("canvas");
                                canvas.width=viewport.width;canvas.height=viewport.height;
                                const context=canvas.getContext("2d");
                                await page.render({canvasContext:context,viewport:viewport}).promise;
                                const imgData=canvas.toDataURL("image/png");
                                console.log(`جارٍ استخراج النص من الصفحة ${pageNum}...`);
                                const wordsData=await extractTextFromImage(imgData);
                                return{imgData,wordsData,pageNum};
                            })());
                        }
                        resolve(await Promise.all(pagesDataPromises));
                    }catch(error){reject(error)}
                };
                reader.readAsArrayBuffer(file);
            });
        }

        async function extractTextFromImage(imgData){
            if(typeof Tesseract==='undefined'){alert("مكتبة Tesseract.js غير متاحة. لا يمكن استخراج النص أوفلاين بدون معالجة مسبقة.");throw new Error("Tesseract.js not loaded")}
            output.textContent += " Extracting the text...\n";
            console.log("بدء تشغيل Tesseract");
            try{
                const worker=await Tesseract.createWorker("eng",1);
                const {data}=await worker.recognize(imgData);
                await worker.terminate();
                console.log("تم إنهاء عامل Tesseract");
                output.style.display="block";
                output.textContent+=`نص الصفحة (مستخرج): ${data.text.substring(0,100)}...\n`;
                console.log("نتيجة Tesseract:",data.text?data.text.substring(0,100)+"...":"No text found");
                return data;
            }catch(error){
                output.textContent+=`خطأ أثناء استخراج النص: ${error.message}\n`;
                console.error("خطأ في Tesseract:",error);
                return{words:[]};
            }
        }

        async function translateWord(word){
            const lowerWord=word.toLowerCase().replace(/[^a-z]/gi,'');
            if(!lowerWord)return"غير مترجم";
            if(translationCache.has(lowerWord))return translationCache.get(lowerWord);
            if(fallbackTranslations[lowerWord]){translationCache.set(lowerWord,fallbackTranslations[lowerWord]);return fallbackTranslations[lowerWord]}
            if(navigator.onLine){
                try{
                    console.log(`طلب ترجمة من MyMemory API لـ ${lowerWord}`);
                    const response=await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(lowerWord)}&langpair=en|ar`);
                    if(!response.ok)throw new Error(`HTTP ${response.status}`);
                    const data=await response.json();
                    let translation=data.responseData.translatedText||"غير مترجم";
                    if(translation.includes(","))translation=translation.split(",")[0].trim();
                    translationCache.set(lowerWord,translation);
                    console.log(`ترجمة API لـ ${lowerWord}: ${translation}`);
                    return translation;
                }catch(error){
                    console.error(`خطأ في ترجمة ${lowerWord} عبر API:`,error);
                    translationCache.set(lowerWord,"غير مترجم");
                    return"غير مترجم";
                }
            }else{
                console.log(`أوفلاين، لا يمكن ترجمة ${lowerWord} عبر API.`);
                translationCache.set(lowerWord,"غير مترجم (أوفلاين)");
                return"غير مترجم (أوفلاين)";
            }
        }

        async function compressImage(imgData,quality=0.7,format="image/jpeg"){
            return new Promise(resolve=>{
                const img=new Image();
                img.src=imgData;
                img.onload=()=>{
                    const canvas=document.createElement("canvas");
                    canvas.width=img.width;canvas.height=img.height;
                    const ctx=canvas.getContext("2d");
                    ctx.drawImage(img,0,0);
                    const compressedData=canvas.toDataURL(format,quality);
                    resolve(compressedData);
                };
                img.onerror=()=>resolve(imgData);
            });
        }

        async function processExtractedWordsWithTranslation(pagesData){
            const allPagesProcessedData=[];
            for(const page of pagesData){
                const filteredWordsData=[];
                if(page.wordsData&&page.wordsData.words){
                    for(const wordDetails of page.wordsData.words){
                        const text=wordDetails.text?.toLowerCase().replace(/[^a-z]/gi,'');
                        if(text&&wordDetails.confidence>=50&&text.length>2&&!stopWords.includes(text)){
                            const translation=await translateWord(text);
                            filteredWordsData.push({
                                text:wordDetails.text,
                                bbox:wordDetails.bbox,
                                translation:translation
                            });
                        }
                    }
                }
                const compressedImgData=await compressImage(page.imgData,0.7,"image/jpeg");
                allPagesProcessedData.push({
                    imgData:compressedImgData,
                    wordsData:filteredWordsData,
                    pageNum:page.pageNum
                });
            }
            return allPagesProcessedData;
        }

        async function renderPages(pagesToRender){
            container.innerHTML="";
            for(const pageData of pagesToRender){
                const pageContainer=document.createElement("div");
                pageContainer.className="page-container";
                pageContainer.dataset.pageNum=pageData.pageNum;
                const img=document.createElement("img");
                img.className="page-image";
                img.src=pageData.imgData;
                img.alt=`صفحة مانهوا ${pageData.pageNum}`;
                img.onload=()=>{
                    pageContainer.appendChild(img);
                    container.appendChild(pageContainer);
                    drawWordBoxes(pageData.wordsData,img,pageContainer);
                };
                img.onerror=()=>{
                    console.error(`فشل تحميل الصورة (Base64) للصفحة ${pageData.pageNum}`);
                    output.textContent+=`خطأ: فشل تحميل الصورة للصفحة ${pageData.pageNum}\n`;
                };
            }
            setTimeout(()=>{
                if(output.textContent.length>2000)output.style.display="none";
            },5000);
        }

        function drawWordBoxes(words,imgElement,pageContainerElement){
            const existingWords=pageContainerElement.querySelectorAll(".word");
            existingWords.forEach(wordDiv=>wordDiv.remove());
            const scaleX=imgElement.clientWidth/imgElement.naturalWidth;
            const scaleY=imgElement.clientHeight/imgElement.naturalHeight;
            for(const word of words){
                const box=word.bbox;
                if(!box)continue;
                const wordDiv=document.createElement("div");
                wordDiv.className="word";
                wordDiv.style.left=`${box.x0*scaleX}px`;
                wordDiv.style.top=`${box.y0*scaleY}px`;
                wordDiv.style.width=`${(box.x1-box.x0)*scaleX}px`;
                wordDiv.style.height=`${(box.y1-box.y0)*scaleY}px`;
                pageContainerElement.appendChild(wordDiv);
                wordDiv.addEventListener("click",e=>{
                    e.stopPropagation();
                    console.log(`تم النقر على الكلمة: ${word.text}`);
                    showTooltip(wordDiv,word.text,word.translation,e.clientX,e.clientY);
                });
            }
        }

        function showTooltip(wordDiv,originalWord,translation,x,y){
            const existingTooltip=document.querySelector(".tooltip");
            if(existingTooltip)existingTooltip.remove();
            const tooltip=document.createElement("div");
            tooltip.className="tooltip";
            tooltip.innerHTML=`
                <div>
                    <strong>الكلمة:</strong> ${originalWord}<br>
                    <strong>الترجمة:</strong> ${translation}<br>
                    <button onclick="pronounceWord('${originalWord.replace(/[^a-zA-Z0-9\s]/g,'')}')">نطق الكلمة</button>
                </div>`;
            document.body.appendChild(tooltip);
            const rect=tooltip.getBoundingClientRect();
            let left=x+15,top=y+15;
            if(left+rect.width>window.innerWidth)left=x-rect.width-15;
            if(top+rect.height>window.innerHeight)top=y-rect.height-15;
            if(left<0)left=5;if(top<0)top=5;
            tooltip.style.left=`${left}px`;
            tooltip.style.top=`${top}px`;
            tooltip.style.display="block";
            function closeTooltipOnClick(event){
                if(!tooltip.contains(event.target)&&event.target!==wordDiv){
                    tooltip.remove();
                    document.removeEventListener("click",closeTooltipOnClick,true);
                }
            }
            document.addEventListener("click",closeTooltipOnClick,true);
        }

        window.pronounceWord=function(wordToPronounce){
            if(!window.speechSynthesis){alert("ميزة النطق غير مدعومة في متصفحك.");return}
            const utterance=new SpeechSynthesisUtterance(wordToPronounce);
            utterance.lang="en-US";
            speechSynthesis.speak(utterance);
        };

        container.addEventListener("dragstart",e=>{
            if(e.target.classList.contains("page-image"))e.preventDefault();
        });

        window.addEventListener("resize",()=>{
            console.log("تم تغيير حجم النافذة، جارٍ إعادة رسم المربعات...");
            redrawWordBoxesOnResize();
        });

        function redrawWordBoxesOnResize(){
            const dataToRedraw=processedPagesDataForOffline.length>0?processedPagesDataForOffline:(document.getElementById('offlineData').textContent?JSON.parse(document.getElementById('offlineData').textContent):[]);
            if(!dataToRedraw||dataToRedraw.length===0)return;
            for(const pageData of dataToRedraw){
                const pageContainer=container.querySelector(`.page-container[data-page-num="${pageData.pageNum}"]`);
                const img=pageContainer?.querySelector(".page-image");
                if(img&&pageContainer&&pageData.wordsData){
                    if(img.complete){
                        drawWordBoxes(pageData.wordsData,img,pageContainer);
                    }else{
                        img.onload=()=>drawWordBoxes(pageData.wordsData,img,pageContainer);
                    }
                }
            }
        }

        saveOfflineButton.addEventListener("click",()=>{
            if(processedPagesDataForOffline.length>0){
                generateAndDownloadOfflineHTML(processedPagesDataForOffline);
            }else{
                alert("لا توجد بيانات لمعالجتها وحفظها.");
            }
        });

        function generateAndDownloadOfflineHTML(dataToSave){
            const htmlContent=`
<!DOCTYPE html>
<html lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>مانهوا (أوفلاين) - ${new Date().toLocaleDateString()}</title>
    <style>
        body{font-family:Arial,sans-serif;text-align:center;background-color:#f4f4f4;margin:0}
        #container{display:flex;flex-direction:column;align-items:center;margin:20px}
        .page-container{position:relative;margin-bottom:20px;width:fit-content}
        .page-image{max-width:100%;display:block;position:relative;z-index:1}
        .word{position:absolute;border:2px solid rgba(0,0,255,.136);background:rgba(0,0,255,.079);cursor:pointer;z-index:10;pointer-events:auto}
        .tooltip{position:fixed;background:#333;color:#fff;padding:10px;border-radius:5px;z-index:1000;max-width:200px;text-align:left;display:none}
        .tooltip button{margin-top:5px;padding:5px 10px;font-size:12px;background:#007bff;color:#fff;border:none;border-radius:3px;cursor:pointer}
    </style>
</head>
<body>
    <h1>مانهوا للقراءة أوفلاين</h1>
    <p>تم إنشاؤه في: ${new Date().toLocaleString()}</p>
    <div id="container_offline"></div>
    <div id="offlineDataStorage" style="display:none;">${JSON.stringify(dataToSave)}</div>
    <script>
        const offlineContainer=document.getElementById("container_offline"),storedDataElement=document.getElementById("offlineDataStorage");let offlinePagesData=[];try{offlinePagesData=JSON.parse(storedDataElement.textContent)}catch(e){console.error("Failed to parse offline data:",e);offlineContainer.innerHTML="<p>خطأ في تحميل بيانات المانهوا.</p>"}
        function drawWordBoxesOffline(words,imgElement,pageContainerElement){const existingWords=pageContainerElement.querySelectorAll(".word");existingWords.forEach(wordDiv=>wordDiv.remove());const scaleX=imgElement.clientWidth/imgElement.naturalWidth,scaleY=imgElement.clientHeight/imgElement.naturalHeight;for(const word of words){const box=word.bbox;if(!box)continue;const wordDiv=document.createElement("div");wordDiv.className="word";wordDiv.style.left=\`\${box.x0*scaleX}px\`;wordDiv.style.top=\`\${box.y0*scaleY}px\`;wordDiv.style.width=\`\${(box.x1-box.x0)*scaleX}px\`;wordDiv.style.height=\`\${(box.y1-box.y0)*scaleY}px\`;pageContainerElement.appendChild(wordDiv);wordDiv.addEventListener("click",e=>{e.stopPropagation();showTooltipOffline(wordDiv,word.text,word.translation,e.clientX,e.clientY)})}}
        function showTooltipOffline(wordDiv,originalWord,translation,x,y){const existingTooltip=document.querySelector(".tooltip");if(existingTooltip)existingTooltip.remove();const tooltip=document.createElement("div");tooltip.className="tooltip";tooltip.innerHTML=\`<div><strong>الكلمة:</strong> \${originalWord}<br><strong>الترجمة:</strong> \${translation}<br><button onclick="pronounceWordOffline('\${originalWord.replace(/[^a-zA-Z0-9\\\\s]/g,'')}')">نطق الكلمة</button></div>\`;document.body.appendChild(tooltip);const rect=tooltip.getBoundingClientRect();let left=x+15,top=y+15;if(left+rect.width>window.innerWidth)left=x-rect.width-15;if(top+rect.height>window.innerHeight)top=y-rect.height-15;if(left<0)left=5;if(top<0)top=5;tooltip.style.left=\`\${left}px\`;tooltip.style.top=\`\${top}px\`;tooltip.style.display="block";document.addEventListener("click",function closeTT(event){if(!tooltip.contains(event.target)&&event.target!==wordDiv){tooltip.remove();document.removeEventListener("click",closeTT,true)}},true)}
        window.pronounceWordOffline=function(wordToPronounce){if(!window.speechSynthesis){alert("ميزة النطق غير مدعومة.");return}const utterance=new SpeechSynthesisUtterance(wordToPronounce);utterance.lang="en-US";speechSynthesis.speak(utterance)};
        function renderOfflinePages(pagesToRender){offlineContainer.innerHTML="";for(const pageData of pagesToRender){const pageContainer=document.createElement("div");pageContainer.className="page-container";pageContainer.dataset.pageNum=pageData.pageNum;const img=document.createElement("img");img.className="page-image";img.src=pageData.imgData;img.alt=\`صفحة مانهوا \${pageData.pageNum}\`;img.onload=()=>{pageContainer.appendChild(img);offlineContainer.appendChild(pageContainer);if(pageData.wordsData)drawWordBoxesOffline(pageData.wordsData,img,pageContainer)};img.onerror=()=>console.error(\`فشل تحميل الصورة (Base64) للصفحة \${pageData.pageNum}\`)}}
        function redrawWordBoxesOnResizeOffline(){if(!offlinePagesData||offlinePagesData.length===0)return;for(const pageData of offlinePagesData){const pageC=offlineContainer.querySelector(\`.page-container[data-page-num="\${pageData.pageNum}"]\`),imgEl=pageC?.querySelector(".page-image");if(imgEl&&pageC&&pageData.wordsData){if(imgEl.complete)drawWordBoxesOffline(pageData.wordsData,imgEl,pageC);else imgEl.onload=()=>drawWordBoxesOffline(pageData.wordsData,imgEl,pageC)}}}
        window.addEventListener("resize",redrawWordBoxesOnResizeOffline);document.addEventListener("DOMContentLoaded",()=>{if(offlinePagesData.length>0)renderOfflinePages(offlinePagesData);else offlineContainer.innerHTML="<p>لم يتم العثور على بيانات مانهوا مخزنة.</p>"});
    </script>
</body>
</html>`;
            const blob=new Blob([htmlContent],{type:"text/html"});
            const link=document.createElement("a");
            link.href=URL.createObjectURL(blob);
            link.download=`manhwa_offline_${Date.now()}.html`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
            console.log("تم إنشاء ملف HTML للقراءة Offline.");
            output.textContent+="\nتم إنشاء ملف HTML للقراءة Offline وجاهز للتحميل.";
        }

        function loadOfflineHTML(htmlFile){
            const reader=new FileReader();
            reader.onload=e=>{
                const htmlString=e.target.result;
                const parser=new DOMParser();
                const doc=parser.parseFromString(htmlString,"text/html");
                const dataScript=doc.getElementById("offlineDataStorage");
                if(dataScript&&dataScript.textContent){
                    try{
                        const loadedOfflineData=JSON.parse(dataScript.textContent);
                        processedPagesDataForOffline=loadedOfflineData;
                        document.getElementById('offlineData').textContent=dataScript.textContent;
                        container.innerHTML="<h2>تم تحميل بيانات الأوفلاين.</h2><p>أعد تحميل الصفحة أو قم بتشغيل العرض يدويًا إذا لزم الأمر.</p>";
                        renderPages(loadedOfflineData);
                        output.textContent="تم تحميل بيانات المانهوا من ملف HTML.";
                        saveOfflineButton.style.display="none";
                    }catch(err){
                        console.error("فشل في تحليل البيانات من ملف HTML المحمل:",err);
                        output.textContent="فشل في قراءة البيانات من ملف HTML.";
                    }
                }else{
                    output.textContent="ملف HTML المحمل لا يحتوي على بيانات مانهوا متوقعة.";
                }
            };
            reader.readAsText(htmlFile);
        }