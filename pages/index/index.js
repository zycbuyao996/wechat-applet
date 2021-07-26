Page({
  /**
   * 页面的初始数据
   */
  data: {
    mark:0,//输入的分数
    schoollist:[],
   //选择的科目
   },
   formSubmit: function (e) {
    console.log(e);
    this.setData({
      mark:e.detail.value.input,
      checkedList:e.detail.value.checkbox
    })
    const app=getApp();//定义全局变量对象
    app.globalData.checkedList=this.data.checkedList//将选择科目赋值给全局变量，以便在subject中筛选
    wx.cloud.callFunction({
      name:"mysql1",
      data:{
        mark1:e.detail.value.input
      },
      success(res){
        console.log("请求成功",res);
        var jsonData = JSON.stringify(res.result);//转换成json格式数据，就不会打印成[object,object]了

          wx.navigateTo({
    
            url: '/pages/recommend/recommend?schoollist='+jsonData,
          })
 
      },
      fail(res){
        console.log("请求失败",res)
      }
    })
   
   

  },
  formReset: function () {
    console.log('form发生了reset事件')
  },

  
   
  /**
   * 页面开始加载就会触发
   */
  onLoad: function (options) {}
})